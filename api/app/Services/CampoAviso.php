<?php

namespace App\Services;

use App\Models\AtividadeCampo;
use App\Models\Colaborador;
use Carbon\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Acompanhamento de trabalho solitário — quem recebe os avisos e o aviso de "saída registrada" (13/11/2026, pedido do
 * Cleiton): depois do aviso das 3 h, quando a pessoa registra a saída, vai outro aviso para os mesmos (focal, gestor e
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

    /**
     * Última vez que cada pessoa usou o app com internet (o token do aparelho registra cada chamada ao servidor), em ISO.
     * 26/11/2026: a saída tocada sem sinal fica no celular até o sinal voltar, então "sem saída" pode ser só falta de
     * sinal; esta hora entra no aviso e na tela de verificação para quem vai ligar.
     */
    public static function vistoEm(iterable $ids): Collection
    {
        try {
            return DB::table('personal_access_tokens')
                ->where('tokenable_type', (new Colaborador)->getMorphClass())
                ->whereIn('tokenable_id', collect($ids)->all())
                ->selectRaw('tokenable_id, max(last_used_at) as visto')
                ->groupBy('tokenable_id')->pluck('visto', 'tokenable_id')
                ->map(fn ($v) => $v ? Carbon::parse($v, 'UTC')->toIso8601String() : null);
        } catch (\Throwable) {
            return collect();
        }
    }

    /** "celular falou com o servidor às 09:10" (ou "ontem, 17:40"); vazio se nunca falou. */
    public static function vistoTexto(?string $iso): string
    {
        if (! $iso) {
            return '';
        }
        $v = Carbon::parse($iso)->setTimezone(self::TZ);
        $hoje = Carbon::now(self::TZ)->isSameDay($v);

        return ' Celular falou com o servidor '.($hoje ? 'às '.$v->format('H:i') : 'em '.$v->format('d/m H:i')).'.';
    }

    public static function tag(AtividadeCampo $a): string
    {
        return 'campo-longo-'.$a->id;
    }

    /**
     * "Liguei, está tudo bem" (26/11/2026): avisa os outros que acompanham (com a mesma tag, troca o aviso de campo longo
     * no celular) para ninguém ligar de novo. Nunca derruba a confirmação.
     */
    public function verificado(AtividadeCampo $a, Colaborador $quem): void
    {
        try {
            $a->loadMissing('colaborador:id,nome,email');
            $nome = $a->colaborador?->nome ?: ($a->colaborador?->email ?: 'Colaborador');
            $por = $quem->nome ?: $quem->email;
            $destino = self::destinatarios($a->user_id)->reject(fn (Colaborador $c) => $c->id === $quem->id)->values();
            if ($destino->isNotEmpty()) {
                $this->push->enviar($destino,
                    "✅ {$nome} está bem",
                    "{$por} ligou às ".Carbon::now(self::TZ)->format('H:i')." e confirmou ({$a->fazenda} · campo {$a->campo}). Não precisa ligar de novo.",
                    './?abrir=campo',
                    self::tag($a),
                );
            }
        } catch (\Throwable $e) {
            Log::warning('campo.aviso_verificado_falhou', ['id' => $a->id, 'erro' => $e->getMessage()]);
        }
    }

    /** Só avisa se o aviso das 3 h saiu para esta atividade; e uma vez só. Nunca derruba o registro da saída. */
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
