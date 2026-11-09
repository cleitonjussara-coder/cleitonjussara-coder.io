<?php

namespace App\Console\Commands;

use App\Models\Nota;
use App\Services\FotoStorage;
use App\Services\LeitorNota;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * php84 artisan notas:hora-pedagio [--seco] [--limite=N]
 *
 * Mutirão de 09/11/2026 (pedido do Cleiton): os recibos de pedágio lançados antes do build 581 não têm a hora gravada,
 * e sem número legível o par (mesma praça, dia e tarifa) segue no sino como "duplicada". Este comando relê a FOTO de
 * cada recibo de pedágio sem hora com a IA e grava SÓ a hora (notas.hora). Nada mais da nota muda; nada é apagado.
 *
 * Só grava quando a data lida da foto bate com a data da nota (ou a IA não leu data): hora de outro recibo não entra.
 * A gravação sobe o updated_at — é isso que faz os aparelhos puxarem a hora e o sino recalcular.
 *
 * --seco apenas mostra o que seria gravado (mas consulta a IA do mesmo jeito). Rodar de novo só refaz as que faltam.
 */
class NotasHoraPedagio extends Command
{
    protected $signature = 'notas:hora-pedagio {--seco : só mostra, sem gravar} {--limite=0 : no máximo N notas (0 = todas)}';

    protected $description = 'Relê a foto dos recibos de pedágio sem hora e grava a hora da passagem';

    private const EXTS = ['jpg', 'jpeg', 'png', 'webp'];

    private const LADO_MAX = 2000;   // a IA não precisa de 12 MP para ler a hora; foto grande estoura o limite da API

    public function handle(LeitorNota $leitor, FotoStorage $fotos): int
    {
        if (! Nota::temHora()) {
            $this->error('A coluna notas.hora ainda não existe: rode a migração primeiro.');

            return self::FAILURE;
        }
        if (! $leitor->disponivel()) {
            $this->error('A leitura por IA não está configurada neste ambiente.');

            return self::FAILURE;
        }
        $seco = (bool) $this->option('seco');
        $limite = max(0, (int) $this->option('limite'));

        $ids = Nota::query()->where('deleted', false)->whereNull('hora')
            ->whereNotNull('foto_path')->where('foto_path', '<>', '')
            ->where(fn ($q) => $q->where('subtipo', 'Pedágio')->orWhere(fn ($q) => $q->whereNotNull('placa')->where('placa', '<>', '')))
            ->orderBy('data')->when($limite, fn ($q) => $q->limit($limite))
            ->pluck('id')->all();   // lista fechada: nenhuma leitura aberta durante as gravações (SQLite em WAL)

        $c = ['gravadas' => 0, 'sem_hora' => 0, 'data_outra' => 0, 'sem_foto' => 0, 'nao_leu' => 0, 'falhas' => 0];
        foreach ($ids as $id) {
            $nota = Nota::find($id);
            if (! $nota || $nota->hora || ! $nota->foto_path) {
                continue;
            }
            $rotulo = sprintf('%s · %s · %s · R$ %s', substr($nota->id, 0, 8), $nota->data?->format('d/m/Y'),
                mb_substr((string) ($nota->razao_social ?: 'sem fornecedor'), 0, 30), number_format((float) $nota->valor, 2, ',', '.'));

            $img = $this->imagem($fotos, $nota->foto_path);
            if ($img === null) {
                $c['sem_foto']++;
                $this->line("  sem foto legível: {$rotulo}");

                continue;
            }
            $lido = $leitor->ler($img[0], $img[1]);
            if ($lido === null) {
                $c['nao_leu']++;
                $this->line("  IA não respondeu ({$leitor->ultimoMotivo()}): {$rotulo}");

                continue;
            }
            $hora = $lido['hora'] ?? null;
            if (! $hora) {
                $c['sem_hora']++;
                $this->line("  hora não legível: {$rotulo}");

                continue;
            }
            $dataLida = $lido['data'] ?? null;
            if ($dataLida && $dataLida !== $nota->data?->format('Y-m-d')) {
                $c['data_outra']++;
                $this->line("  NÃO gravada — a foto diz {$dataLida} {$hora}: {$rotulo}");

                continue;
            }
            $this->line(($seco ? '  seria gravada ' : '  gravada ')."{$hora}: {$rotulo}");
            if ($seco) {
                $c['gravadas']++;

                continue;
            }
            $this->gravar($nota, $hora) ? $c['gravadas']++ : $c['falhas']++;
        }

        $msg = sprintf('hora do pedágio%s: %d %s de %d recibos sem hora; %d sem hora legível, %d com data diferente, %d sem foto, %d sem resposta da IA%s',
            $seco ? ' (nada foi gravado)' : '', $c['gravadas'], $seco ? 'seriam gravadas' : 'gravadas', count($ids),
            $c['sem_hora'], $c['data_outra'], $c['sem_foto'], $c['nao_leu'],
            $c['falhas'] ? " — ATENÇÃO: {$c['falhas']} gravação(ões) falharam; rode de novo" : '');
        $this->info($msg);
        Log::info($msg);

        return $c['falhas'] ? self::FAILURE : self::SUCCESS;
    }

    /** [bytes, mime] da foto, reduzida para no máximo LADO_MAX px; null se não for imagem ou não estiver no disco. */
    private function imagem(FotoStorage $fotos, string $path): ?array
    {
        if (! in_array(strtolower(pathinfo($path, PATHINFO_EXTENSION)), self::EXTS, true) || ! $fotos->existe($path)) {
            return null;
        }
        $bytes = $fotos->disk()->get($path);
        $im = $bytes ? @imagecreatefromstring($bytes) : false;
        if (! $im) {
            return null;
        }
        $w = imagesx($im);
        $h = imagesy($im);
        $f = min(1, self::LADO_MAX / max($w, $h));
        if ($f < 1) {
            $novo = imagescale($im, (int) round($w * $f), (int) round($h * $f));
            imagedestroy($im);
            $im = $novo;
        }
        ob_start();
        imagejpeg($im, null, 85);
        imagedestroy($im);

        return [(string) ob_get_clean(), 'image/jpeg'];
    }

    /** Grava só a hora, repetindo se o SQLite estiver ocupado. Sobe o updated_at: os aparelhos puxam a hora. */
    private function gravar(Nota $nota, string $hora): bool
    {
        for ($tentativa = 1; $tentativa <= 6; $tentativa++) {
            try {
                $nota->forceFill(['hora' => $hora])->save();

                return true;
            } catch (Throwable $e) {
                Log::warning('notas:hora-pedagio: gravação falhou', ['nota' => $nota->id, 'tentativa' => $tentativa, 'erro' => $e->getMessage()]);
                sleep(min($tentativa, 3));
            }
        }

        return false;
    }
}
