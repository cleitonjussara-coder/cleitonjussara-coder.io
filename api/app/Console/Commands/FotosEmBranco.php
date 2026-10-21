<?php

namespace App\Console\Commands;

use App\Models\Nota;
use App\Services\FotoEmBrancoAviso;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * php84 artisan fotos:em-branco [--seco] [--refazer]
 *
 * Mutirão nos anexos que já estão no servidor (21/10/2026): marca em notas.foto_em_branco as notas cuja foto é
 * papel liso, sem nenhum dado de nota (caso do Pedágio de R$ 14,00 do João Vitor). Só marca — NUNCA apaga a nota
 * nem o arquivo — e não manda push (o sino e a faixa "O que falta corrigir" mostram). Por padrão só mede quem
 * ainda não foi medido (foto_em_branco nulo); --refazer mede tudo de novo.
 *
 * --seco apenas lista, sem gravar.
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

        $vistas = 0;
        $brancas = 0;
        $semArquivo = 0;
        foreach ($q->orderBy('created_at')->cursor() as $nota) {
            $vistas++;
            if ($seco) {
                $r = $aviso->medir($nota->foto_path);
            } else {
                $r = $aviso->avaliar($nota, null, refazer: true, avisar: false);
            }
            if ($r === null) {
                $semArquivo++;

                continue;
            }
            if ($r === true) {
                $brancas++;
                $this->line(sprintf('  em branco: %s · %s · %s · R$ %s · %s', $nota->id, $nota->data?->format('d/m/Y'), $nota->razao_social ?: '(sem fornecedor)', number_format((float) $nota->valor, 2, ',', '.'), $nota->foto_path));
            }
        }

        $msg = ($seco ? 'fotos em branco (nada foi gravado): ' : 'fotos em branco: ')."{$brancas} de {$vistas} notas analisadas".($semArquivo ? " ({$semArquivo} sem arquivo no disco)" : '');
        $this->info($msg);
        Log::info($msg);

        return self::SUCCESS;
    }
}
