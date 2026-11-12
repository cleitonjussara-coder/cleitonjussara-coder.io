<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\PushSubscription;
use App\Services\PushService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Resend\Laravel\Facades\Resend;
use Throwable;

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

    /**
     * GET /push/equipe — gestor/admin veem quem da equipe ativa tem aviso ligado e em quantos aparelhos (12/11/2026,
     * pedido do Cleiton). "Ligado" = aparelho inscrito; se a pessoa desligou direto nas configurações do celular, o
     * servidor só descobre quando um envio falhar (o PushService apaga a inscrição morta).
     */
    public function equipe(Request $r): JsonResponse
    {
        abort_unless($r->user()->gerencia(), 403, 'Só gestor e admin.');

        $porUser = PushSubscription::query()
            ->selectRaw('user_id, COUNT(*) as n, MAX(updated_at) as ultimo')
            ->groupBy('user_id')->get()->keyBy('user_id');

        $q = Colaborador::query()->where('ativo', true)->where('role', '!=', 'contabilidade');
        if (Colaborador::temConfirmacao()) {
            $q->whereNotNull('confirmado_em');
        }

        $lista = $q->orderBy('nome')->get(['id', 'nome', 'role', 'email'])->map(function (Colaborador $c) use ($porUser) {
            $p = $porUser->get($c->id);

            return [
                'id' => $c->id,
                'nome' => $c->nome,
                'role' => $c->role,
                'aparelhos' => (int) ($p->n ?? 0),
                'ultimo' => $p->ultimo ?? null,
                'lembrado_em' => Cache::get(self::chaveLembrete($c->id)),
                'tem_email' => (bool) $c->email,
            ];
        })->values();

        return response()->json([
            'equipe' => $lista,
            'ligados' => $lista->where('aparelhos', '>', 0)->count(),
            'total' => $lista->count(),
        ]);
    }

    /**
     * POST /push/lembrar {ids?: string[]} — e-mail para quem está SEM aviso ligado pedindo para ligar (sem ids = todos
     * os desligados). Notificação no celular não adianta: justamente essas pessoas não recebem. Cada pessoa recebe no
     * máximo um lembrete por dia, para o botão não virar spam.
     */
    public function lembrar(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor e admin.');
        $d = $r->validate(['ids' => ['nullable', 'array', 'max:200'], 'ids.*' => ['string', 'max:36']]);

        $comAviso = PushSubscription::query()->distinct()->pluck('user_id')->all();
        $q = Colaborador::query()->where('ativo', true)->where('role', '!=', 'contabilidade')
            ->whereNotIn('id', $comAviso)->where('id', '!=', $u->id);
        if (Colaborador::temConfirmacao()) {
            $q->whereNotNull('confirmado_em');
        }
        if (! empty($d['ids'])) {
            $q->whereIn('id', $d['ids']);
        }

        $enviados = 0;
        $pulados = 0;
        $falhas = [];
        foreach ($q->get() as $c) {
            if (! $c->email || Cache::has(self::chaveLembrete($c->id))) {
                $pulados++;

                continue;
            }
            [$ok, $erro] = $this->emailLembrete($c, $u);
            if ($ok) {
                Cache::put(self::chaveLembrete($c->id), now()->toIso8601String(), now()->addDay());
                $enviados++;
            } else {
                $falhas[] = ['nome' => $c->nome, 'erro' => $erro];
            }
        }

        return response()->json(['ok' => true, 'enviados' => $enviados, 'pulados' => $pulados, 'falhas' => $falhas]);
    }

    private static function chaveLembrete(string $id): string
    {
        return 'push-lembrete-'.$id;
    }

    /** @return array{0: bool, 1: ?string} */
    private function emailLembrete(Colaborador $c, Colaborador $autor): array
    {
        $app = config('petermann.front_url');
        $texto = "Olá, {$c->nome}.\n\n{$autor->nome} pede que você ligue os avisos do app Petermann & Morais no seu celular.\n\n"
            ."Com os avisos ligados, o celular toca quando pedirem justificativa ou correção de nota e quando cair repasse ou recarga.\n\n"
            ."Como ligar (leva 10 segundos):\n"
            ."1. Abra o app ({$app})\n"
            ."2. Toque no sino 🔔 no topo da tela\n"
            ."3. Toque em \"Ligar avisos neste celular\" e responda Permitir\n\n"
            ."No iPhone, o app precisa estar instalado na Tela de Início (Compartilhar → Adicionar à Tela de Início) e ser aberto pelo ícone.";
        try {
            if (! config('resend.api_key')) {
                throw new \RuntimeException('RESEND_API_KEY não configurada');
            }
            Resend::emails()->send(array_filter([
                'from' => config('petermann.repasse.from'),
                'to' => [$c->email],
                'reply_to' => $autor->email ?: null,
                'subject' => 'Ligue os avisos do app no celular — Petermann & Morais',
                'text' => $texto,
            ]));

            return [true, null];
        } catch (Throwable $e) {
            Log::warning("lembrete de aviso para {$c->email} falhou: ".$e->getMessage());

            return [false, mb_substr($e->getMessage(), 0, 200)];
        }
    }
}
