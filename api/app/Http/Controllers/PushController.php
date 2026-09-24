<?php

namespace App\Http\Controllers;

use App\Models\PushSubscription;
use App\Services\PushService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Inscrição do aparelho para receber notificação (24/09/2026).
 *
 * O app manda o endpoint e as duas chaves que o navegador gerou; o servidor
 * guarda e passa a usar como endereço. Cada aparelho tem o seu.
 */
class PushController extends Controller
{
    public function __construct(private PushService $push) {}

    /** GET /push/chave — a chave pública VAPID, que o navegador precisa para se inscrever. */
    public function chave(): JsonResponse
    {
        return response()->json([
            'chave' => config('petermann.push.public'),
            'ativo' => $this->push->configurado(),
        ]);
    }

    /** POST /push/inscrever */
    public function inscrever(Request $r): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'endpoint' => ['required', 'string', 'max:2000'],
            'p256dh' => ['required', 'string', 'max:120'],
            'auth' => ['required', 'string', 'max:60'],
            'aparelho' => ['nullable', 'string', 'max:120'],
        ]);

        $inscricao = PushSubscription::updateOrCreate(
            ['endpoint_hash' => hash('sha256', $d['endpoint'])],
            [
                'user_id' => $u->id,
                'endpoint' => $d['endpoint'],
                'p256dh' => $d['p256dh'],
                'auth' => $d['auth'],
                'aparelho' => $d['aparelho'] ?? null,
            ]
        );

        return response()->json(['ok' => true, 'id' => $inscricao->id]);
    }

    /** DELETE /push/inscrever — o aparelho pediu para parar de receber. */
    public function desinscrever(Request $r): JsonResponse
    {
        $endpoint = (string) $r->input('endpoint');
        if ($endpoint) {
            PushSubscription::where('endpoint_hash', hash('sha256', $endpoint))
                ->where('user_id', $r->user()->id)->delete();
        }

        return response()->json(['ok' => true]);
    }

    /** POST /push/testar — manda um aviso para o próprio aparelho, para conferir. */
    public function testar(Request $r): JsonResponse
    {
        $n = $this->push->enviar(
            $r->user(),
            'Notificações ligadas ✅',
            'É assim que os avisos do Petermann vão chegar neste aparelho.',
            '/',
            'teste'
        );

        return response()->json(['ok' => $n > 0, 'enviados' => $n]);
    }
}
