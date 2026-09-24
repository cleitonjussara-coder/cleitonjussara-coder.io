<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\PushSubscription;
use Illuminate\Support\Facades\Log;
use Minishlink\WebPush\Subscription;
use Minishlink\WebPush\WebPush;

/**
 * Notificação no celular (Web Push, 24/09/2026).
 *
 * É ela que faz aparecer o número no ícone do app: o Android conta as
 * notificações não lidas e desenha o contador sozinho, como faz com app
 * nativo. A API de badge do navegador não existe no Android.
 *
 * Silencioso por natureza: se o envio falhar, o app continua funcionando —
 * a notificação é um aviso a mais, nunca o caminho principal de nada. O que
 * volta com 404/410 é inscrição morta (app desinstalado, cache limpo) e é
 * apagada na hora.
 */
class PushService
{
    public function configurado(): bool
    {
        return (bool) (config('petermann.push.public') && config('petermann.push.private'));
    }

    /** @param  Colaborador|iterable<Colaborador>  $destino */
    public function enviar($destino, string $titulo, string $corpo, string $url = '/', ?string $tag = null): int
    {
        if (! $this->configurado()) {
            return 0;
        }

        $ids = collect(is_iterable($destino) ? $destino : [$destino])
            ->map(fn ($u) => is_string($u) ? $u : $u->id)->filter()->unique()->all();
        if (! $ids) {
            return 0;
        }

        $inscricoes = PushSubscription::whereIn('user_id', $ids)->get();
        if ($inscricoes->isEmpty()) {
            return 0;
        }

        try {
            $push = new WebPush([
                'VAPID' => [
                    'subject' => config('petermann.push.subject'),
                    'publicKey' => config('petermann.push.public'),
                    'privateKey' => config('petermann.push.private'),
                ],
            ]);
            $push->setReuseVAPIDHeaders(true);
        } catch (\Throwable $e) {
            Log::warning('push: não foi possível iniciar', ['erro' => $e->getMessage()]);

            return 0;
        }

        $carga = json_encode([
            'titulo' => $titulo,
            'corpo' => $corpo,
            'url' => $url,
            'tag' => $tag,
        ], JSON_UNESCAPED_UNICODE);

        $porEndpoint = [];
        foreach ($inscricoes as $i) {
            $porEndpoint[$i->endpoint] = $i;
            try {
                $push->queueNotification(Subscription::create([
                    'endpoint' => $i->endpoint,
                    'publicKey' => $i->p256dh,
                    'authToken' => $i->auth,
                ]), $carga);
            } catch (\Throwable $e) {
                Log::warning('push: inscrição inválida', ['id' => $i->id, 'erro' => $e->getMessage()]);
            }
        }

        $enviados = 0;
        try {
            foreach ($push->flush() as $r) {
                if ($r->isSuccess()) {
                    $enviados++;
                    continue;
                }
                $status = $r->getResponse()?->getStatusCode();
                $inscricao = $porEndpoint[$r->getEndpoint()] ?? null;
                if (in_array($status, [404, 410], true) && $inscricao) {
                    $inscricao->delete();      // aparelho sumiu: não insiste
                    continue;
                }
                Log::info('push: falhou', ['status' => $status, 'motivo' => $r->getReason()]);
            }
        } catch (\Throwable $e) {
            Log::warning('push: erro no envio', ['erro' => $e->getMessage()]);
        }

        return $enviados;
    }

    /** Atalho: avisa todo mundo que gerencia (gestor e admin). */
    public function avisarGestores(string $titulo, string $corpo, string $url = '/', ?string $tag = null): int
    {
        $gestores = Colaborador::whereIn('role', ['gestor', 'admin'])->where('ativo', true)->get();

        return $this->enviar($gestores, $titulo, $corpo, $url, $tag);
    }
}
