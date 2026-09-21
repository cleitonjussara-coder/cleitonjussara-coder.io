<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Services\FotoStorage;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\URL;
use InvalidArgumentException;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Entrega dos anexos. Dois jeitos de autorizar, como o Storage do Supabase:
 *   • URL assinada temporária (para <img src>, que não manda cabeçalho) —
 *     POST /fotos/urls devolve uma por caminho, válida por 5 min;
 *   • Bearer normal (fetch do app para baixar e mandar ao Drive).
 * Quem pode ver: dono da pasta (user_id) ou gestor/admin.
 */
class FotoController extends Controller
{
    public function __construct(private FotoStorage $fotos) {}

    /** POST /fotos/urls {paths: [...]} → [{path, url}|{path, url:null}] */
    public function urls(Request $r): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate(['paths' => ['required', 'array', 'max:500'], 'paths.*' => ['string'], 'mini' => ['nullable', 'boolean']]);
        $mini = (bool) ($d['mini'] ?? false);

        $out = [];
        foreach ($d['paths'] as $p) {
            $url = null;
            try {
                $path = $this->fotos->validarCaminho($p);
                if ($this->podeVer($u, $path) && $this->fotos->existe($path)) {
                    $url = $mini ? $this->urlMini($path) : $this->urlCheia($path);
                }
            } catch (InvalidArgumentException) {
                // caminho inválido → url null
            }
            $out[] = ['path' => $p, 'url' => $url];
        }

        return response()->json($out);
    }

    /** GET /fotos/{path} — assinatura válida OU Bearer autorizado. */
    public function show(Request $r, string $path): StreamedResponse
    {
        $path = $this->fotos->validarCaminho($path);

        $autorizado = $r->hasValidSignature();
        if (! $autorizado) {
            $u = auth('sanctum')->user();
            $autorizado = $u instanceof Colaborador && $this->podeVer($u, $path);
        }
        abort_unless($autorizado, 403, 'Sem permissão para este anexo');
        abort_unless($this->fotos->existe($path), 404, 'Anexo não encontrado');

        /* ?mini=1 → miniatura (gera na primeira vez). Se não der (PDF, HEIC),
           cai na foto inteira: o quadradinho fica pesado, mas nunca vazio. */
        if ($r->boolean('mini')) {
            $m = $this->fotos->miniatura($path);
            if ($m) {
                return $this->fotos->disk()->response($m, basename($m), [
                    'Content-Type' => 'image/jpeg',
                    'Cache-Control' => 'private, max-age=86400',
                ]);
            }
        }

        return $this->fotos->disk()->response($path, basename($path), [
            'Content-Type' => $this->fotos->mimeDe($path),
            'Cache-Control' => 'private, max-age='.config('petermann.foto_url_ttl'),
        ]);
    }

    public function urlCheia(string $path): string
    {
        return URL::temporarySignedRoute('fotos.show', now()->addSeconds(config('petermann.foto_url_ttl')), ['path' => $path]);
    }

    /**
     * URL da miniatura com validade "arredondada" para a hora: a mesma URL
     * durante a hora inteira (vale de 1 a 2 h). É o que deixa o navegador
     * reaproveitar o cache entre uma abertura e outra da tela Arquivos —
     * com o expires mudando a cada pedido, cada visita baixava tudo de novo.
     */
    public function urlMini(string $path): string
    {
        return URL::temporarySignedRoute('fotos.show', now()->startOfHour()->addHours(2), ['path' => $path, 'mini' => 1]);
    }

    private function podeVer(Colaborador $u, string $path): bool
    {
        // foto de perfil é pública dentro da equipe (aparece no cartão do colega)
        if (preg_match('~^[^/]+/perfil\.[a-z0-9]+$~i', $path)) {
            return true;
        }

        return $u->veTudo() || str_starts_with($path, $u->id.'/');
    }
}
