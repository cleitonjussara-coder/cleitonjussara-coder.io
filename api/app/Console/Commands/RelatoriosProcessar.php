<?php

namespace App\Console\Commands;

use App\Models\Colaborador;
use App\Models\RelatorioPedido;
use App\Services\PlanilhasEquipe;
use App\Services\PushService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * php84 artisan relatorios:processar
 *
 * Linha do crontab (a cada minuto):
 *   * * * * * /usr/bin/php84 /home/.../api-petermann/artisan relatorios:processar
 *
 * Gera as planilhas da equipe fora da requisição (06/11/2026). A trava evita duas rodadas ao mesmo tempo: pedido grande
 * passa de um minuto. Arquivo pronto fica 24 h e depois sai sozinho, porque traz dados de todos e não é backup.
 */
class RelatoriosProcessar extends Command
{
    private const TRAVADO_MIN = 40;

    private const GUARDAR_HORAS = 24;

    private const RODADA_MIN = 50;

    protected $signature = 'relatorios:processar';

    protected $description = 'Gera as planilhas da equipe que estão na fila';

    public function handle(PlanilhasEquipe $planilhas, PushService $push): int
    {
        if (! RelatorioPedido::tabelaExiste()) {
            return self::SUCCESS;
        }
        $trava = Cache::lock('relatorios-processar', self::RODADA_MIN * 60 + 600);
        if (! $trava->get()) {
            return self::SUCCESS;
        }
        try {
            @ini_set('memory_limit', '1024M');
            @set_time_limit(0);
            $this->soltarTravados();
            $inicio = time();
            while (time() - $inicio < self::RODADA_MIN * 60) {
                $p = RelatorioPedido::where('estado', 'fila')->orderBy('created_at')->first();
                if (! $p) {
                    break;
                }
                $this->gerar($p, $planilhas, $push);
            }
            $this->limpar();
        } finally {
            $trava->release();
        }

        return self::SUCCESS;
    }

    private function gerar(RelatorioPedido $p, PlanilhasEquipe $planilhas, PushService $push): void
    {
        $p->forceFill(['estado' => 'gerando', 'iniciado_em' => now()])->save();
        $parametros = $p->parametros;
        $pasta = storage_path('app/relatorios');
        if (! is_dir($pasta)) {
            mkdir($pasta, 0755, true);
        }
        $destino = $pasta.'/'.$p->id.'.'.($parametros['modo'] === 'zip' ? 'zip' : 'xlsx');
        try {
            $colabs = $planilhas->colaboradores((int) $parametros['ano'], $parametros['ids'] ?? []);
            $planilhas->gerar($colabs, (int) $parametros['ano'], $parametros['modo'], $destino);
            $p->forceFill(['estado' => 'pronto', 'arquivo' => $destino, 'concluido_em' => now()])->save();
            $this->info("relatorios:processar: {$p->id} pronto, {$colabs->count()} pessoa(s)");
        } catch (\Throwable $e) {
            @unlink($destino);
            Log::error('planilhas da equipe: '.$e->getMessage(), ['pedido' => $p->id]);
            $p->forceFill(['estado' => 'erro', 'erro' => 'Não foi possível gerar as planilhas. Tente de novo.', 'concluido_em' => now()])->save();

            return;
        }
        try {
            $dono = Colaborador::find($p->user_id);
            if ($dono) {
                $push->enviar($dono, 'Planilhas prontas', 'Abra o app para baixar as planilhas da equipe.', '/', 'planilhas-'.$p->id);
            }
        } catch (\Throwable $e) {
            Log::warning('planilhas da equipe: aviso não saiu: '.$e->getMessage());
        }
    }

    /* processo morto no meio deixa o pedido em "gerando" para sempre e o gestor esperando */
    private function soltarTravados(): void
    {
        RelatorioPedido::where('estado', 'gerando')->where('iniciado_em', '<', now()->subMinutes(self::TRAVADO_MIN))
            ->update(['estado' => 'erro', 'erro' => 'A geração foi interrompida. Tente de novo.', 'concluido_em' => now()]);
    }

    private function limpar(): void
    {
        foreach (RelatorioPedido::whereIn('estado', ['pronto', 'erro'])->where('concluido_em', '<', now()->subHours(self::GUARDAR_HORAS))->get() as $p) {
            if ($p->arquivo) {
                @unlink($p->arquivo);
            }
            $p->delete();
        }
    }
}
