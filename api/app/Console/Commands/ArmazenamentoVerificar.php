<?php

namespace App\Console\Commands;

use App\Services\AlertaErro;
use App\Services\Armazenamento;
use App\Services\PontoCalculo;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * php84 artisan armazenamento:verificar
 *
 * Linha do crontab da Locaweb (1x por dia, de madrugada):
 *   10 4 * * * /usr/bin/php84 /home/.../api-petermann/artisan armazenamento:verificar
 * Mede o espaço ocupado, guarda a amostra do dia e manda e-mail quando:
 *   • uso >= ARMAZENAMENTO_AVISO_PCT (80 %) ou >= CRITICO_PCT (90 %) do plano;
 *   • o último backup automático tem mais de 8 dias (crontab parou);
 *   • no ritmo atual o espaço acaba em menos de 60 dias.
 * O aviso do mesmo tipo sai no máximo 1x por dia (chave no AlertaErro).
 */
class ArmazenamentoVerificar extends Command
{
    protected $signature = 'armazenamento:verificar {--sem-email : só mede e registra}';

    protected $description = 'Mede o espaço em disco do app, guarda o histórico e avisa por e-mail se estiver acabando';

    public function handle(Armazenamento $a, AlertaErro $alerta): int
    {
        $m = $a->medir();
        $a->registrar($m);
        $t = $a->tendencia($a->historico(), $m['limite_mb']);

        $mb = fn (int $b) => number_format($b / 1048576, 1, ',', '.').' MB';
        $resumo = sprintf('armazenamento: total %s (banco %s, fotos %s em %d arquivos, backups %s em %d, logs %s)%s; último backup %s; nível %s',
            $mb($m['total']), $mb($m['partes']['banco']['bytes']), $mb($m['partes']['fotos']['bytes']), $m['partes']['fotos']['n'],
            $mb($m['partes']['backups']['bytes']), $m['partes']['backups']['n'], $mb($m['partes']['logs']['bytes']),
            $m['pct'] !== null ? " = {$m['pct']} % do teto de {$m['limite_mb']} MB" : ' (teto de alerta não definido)',
            $m['ultimo_backup'] ? "há {$m['ultimo_backup']['dias']} dia(s)" : 'NENHUM',
            $m['nivel']);
        $this->info($resumo);
        Log::info($resumo);

        if ($this->option('sem-email')) {
            return self::SUCCESS;
        }

        $dia = now(PontoCalculo::TZ)->format('Y-m-d');
        $detalhe = $resumo."\n\n"
            .'Crescimento: '.($t['por_mes'] !== null ? $mb(max(0, $t['por_mes'])).' por mês' : 'ainda sem histórico')
            .($t['dias_ate_limite'] !== null ? " · no ritmo atual o limite acaba em ~{$t['dias_ate_limite']} dias" : '')
            ."\n\nO que fazer: Perfil → 🗄️ Armazenamento no app mostra o detalhe. Para liberar espaço, "
            .'reduza a rotação do backup (--manter) ou peça mais espaço no painel da Locaweb.';

        if ($m['nivel'] === 'critico') {
            $alerta->avisar("Armazenamento CRÍTICO: {$m['pct']} % do teto de alerta", $detalhe, 'armazenamento-critico-'.$dia);
        } elseif ($m['pct'] !== null && $m['pct'] >= (float) config('petermann.armazenamento.aviso_pct', 80)) {
            $alerta->avisar("Armazenamento em {$m['pct']} % do teto de alerta", $detalhe, 'armazenamento-aviso-'.$dia);
        }
        if (! $m['ultimo_backup'] || $m['ultimo_backup']['dias'] > 8) {
            $alerta->avisar('Backup automático atrasado', 'O backup semanal (backup:gerar) não roda há '
                .($m['ultimo_backup']['dias'] ?? '?')." dia(s). Confira o Crontab no painel da Locaweb.\n\n".$detalhe, 'backup-atrasado-'.$dia);
        }
        if ($t['dias_ate_limite'] !== null && $t['dias_ate_limite'] < 60 && $m['nivel'] !== 'critico') {
            $alerta->avisar("Espaço acaba em ~{$t['dias_ate_limite']} dias no ritmo atual", $detalhe, 'armazenamento-tendencia-'.$dia);
        }

        return self::SUCCESS;
    }
}
