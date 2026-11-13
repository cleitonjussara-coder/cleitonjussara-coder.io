<?php

namespace App\Services;

use App\Models\AtividadeCampo;
use App\Models\Colaborador;
use Carbon\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * Acompanhamento de trabalho solitário — quem recebe os avisos e o aviso de "saída registrada" (13/11/2026, pedido do
 * Cleiton): depois do aviso das 2h30, quando a pessoa registra a saída, vai outro aviso para os mesmos (focal, gestor e
 * admin). Usa a mesma tag do aviso de campo longo, então no celular o "ainda sem fim registrado" é trocado pelo
 * "registrou a saída" e não fica para trás uma mensagem que já não vale.
 */
class CampoAviso
{
    private const TZ = 'America/Sao_Paulo';

    public function __construct(private PushService $push) {}

    /** focal + gestor + admin ativos, menos a própria pessoa que está em campo */
    public static function destinatarios(string $userId): Collection
    {
        return Colaborador::where('ativo', true)->get()
            ->filter(fn (Colaborador $c) => $c->gerencia() || $c->acompanhaCampo())
            ->reject(fn (Colaborador $c) => $c->id === $userId)->values();
    }

    public static function tag(AtividadeCampo $a): string
    {
        return 'campo-longo-'.$a->id;
    }

    /** Só avisa se o aviso das 2h30 saiu para esta atividade; e uma vez só. Nunca derruba o registro da saída. */
    public function saidaRegistrada(AtividadeCampo $a): void
    {
        try {
            if (! $a->fim || ! Cache::has('campo-alerta-gestor-'.$a->id) || Cache::has('campo-saida-'.$a->id)) {
                return;
            }
            Cache::put('campo-saida-'.$a->id, now()->toIso8601String(), now()->addDays(3));
            $a->loadMissing('colaborador:id,nome,email');
            $nome = $a->colaborador?->nome ?: ($a->colaborador?->email ?: 'Colaborador');
            $inicio = Carbon::parse($a->inicio->format('Y-m-d H:i:s'), self::TZ);
            $fim = Carbon::parse($a->fim->format('Y-m-d H:i:s'), self::TZ);
            $min = (int) $inicio->diffInMinutes($fim, true);
            $m = $min % 60;
            $tempo = intdiv($min, 60).'h'.($m ? sprintf('%02d', $m) : '');
            $como = $a->fim_automatico ? ' (fechado sozinho ao iniciar outro campo)' : '';
            $destino = self::destinatarios($a->user_id);
            if ($destino->isNotEmpty()) {
                $this->push->enviar($destino,
                    "✅ {$nome} registrou a saída",
                    "{$a->fazenda} · campo {$a->campo}: das ".$inicio->format('H:i').' às '.$fim->format('H:i')." ({$tempo}){$como}. Pode desconsiderar o aviso anterior.",
                    './?abrir=campo',
                    self::tag($a),
                );
            }
        } catch (\Throwable $e) {
            Log::warning('campo.aviso_saida_falhou', ['id' => $a->id, 'erro' => $e->getMessage()]);
        }
    }
}
