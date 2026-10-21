<?php

namespace App\Console\Commands;

use App\Models\Nota;
use App\Services\FotoEmBrancoAviso;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * php84 artisan fotos:em-branco [--seco] [--refazer]
 *
 * Mutirão nos anexos que já estão no servidor (21/10/2026): marca em notas.foto_em_branco as notas cuja foto é
 * papel liso, sem nenhum dado de nota (caso do Pedágio de R$ 14,00 do João Vitor). Só marca — NUNCA apaga a nota
 * nem o arquivo — e não manda push (o sino e a faixa "O que falta corrigir" mostram). Por padrão só mede quem
 * ainda não foi medido (foto_em_branco nulo); --refazer mede tudo de novo.
 *
 * --seco apenas lista, sem gravar.
 *
 * Só a nota que VIRA "em branco" tem o updated_at mexido (é isso que faz os aparelhos puxarem a marca); as que
 * têm conteúdo só guardam o "medida, tudo certo" sem tocar no updated_at — ele aparece para o gestor como
 * "enviada ao servidor em", e uma varredura não pode mudar isso em centenas de notas (a 1ª execução em produção,
 * em 21/10/2026, mexeu em 284).
 *
 * A produção está em uso enquanto isto roda: os ids são lidos ANTES (sem manter uma leitura aberta durante as
 * gravações — no SQLite em WAL isso faz a gravação falhar na hora com "database is locked", 159 vezes na 1ª
 * execução) e cada gravação é repetida algumas vezes se o banco estiver ocupado.
 */
class FotosEmBranco extends Command
{
    protected $signature = 'fotos:em-branco {--seco : só lista, sem gravar} {--refazer : mede também as que já foram medidas}';

    protected $description = 'Marca as notas cujo anexo é uma foto em branco (sem dados de nota)';

    public function handle(FotoEmBrancoAviso $aviso): int
    {
        if (! Nota::temFotoEmBranco()) {
            $this->error('A coluna notas.foto_em_branco ainda não existe: rode a migração (Perfil → Atualizar estrutura do banco).');

            return self::FAILURE;
        }
        $seco = (bool) $this->option('seco');
        $refazer = (bool) $this->option('refazer');

        $q = Nota::query()->where('deleted', false)->whereNotNull('foto_path')->where('foto_path', '<>', '');
        if (! $refazer) {
            $q->whereNull('foto_em_branco');
        }
        $ids = $q->orderBy('created_at')->pluck('id')->all();   // lista fechada: nenhuma leitura fica aberta durante as gravações

        $vistas = 0;
        $brancas = 0;
        $semArquivo = 0;
        $falhas = 0;
        foreach ($ids as $id) {
            $nota = Nota::find($id);
            if (! $nota || ! $nota->foto_path) {
                continue;
            }
            $vistas++;
            $r = $aviso->medir($nota->foto_path);
            if ($r === null) {
                $semArquivo++;

                continue;
            }
            if ($r === true) {
                $brancas++;
                $this->line(sprintf('  em branco: %s · %s · %s · R$ %s · %s', $nota->id, $nota->data?->format('d/m/Y'), $nota->razao_social ?: '(sem fornecedor)', number_format((float) $nota->valor, 2, ',', '.'), $nota->foto_path));
            }
            if ($seco) {
                continue;
            }
            if (! $this->gravar($nota, $r)) {
                $falhas++;
            }
        }

        $msg = ($seco ? 'fotos em branco (nada foi gravado): ' : 'fotos em branco: ')."{$brancas} de {$vistas} notas analisadas"
            .($semArquivo ? " ({$semArquivo} sem arquivo no disco)" : '')
            .($falhas ? " — ATENÇÃO: {$falhas} gravação(ões) falharam (banco ocupado); rode de novo, só as que faltam são refeitas" : '');
        $this->info($msg);
        Log::info($msg);

        return $falhas ? self::FAILURE : self::SUCCESS;
    }

    /** Grava o resultado, repetindo se o SQLite estiver ocupado. true = gravou. */
    private function gravar(Nota $nota, bool $emBranco): bool
    {
        for ($tentativa = 1; $tentativa <= 6; $tentativa++) {
            try {
                if ($emBranco) {
                    $nota->forceFill(['foto_em_branco' => true])->save();           // sobe o updated_at: os aparelhos puxam a marca
                } else {
                    DB::table('notas')->where('id', $nota->id)->update(['foto_em_branco' => false]);   // sem tocar no updated_at
                }

                return true;
            } catch (Throwable $e) {
                Log::warning('fotos:em-branco: gravação falhou', ['nota' => $nota->id, 'tentativa' => $tentativa, 'erro' => $e->getMessage()]);
                sleep(min($tentativa, 3));
            }
        }

        return false;
    }
}
