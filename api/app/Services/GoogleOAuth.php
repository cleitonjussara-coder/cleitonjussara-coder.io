<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Login com Google feito à mão (Socialite conflita com o Guzzle 8 do
 * Laravel 13, e precisávamos de dois detalhes que ele não dá de graça:
 * pedir o escopo do Drive só para gestor/admin e devolver o access_token
 * do Google ao app, que o usa no GDrive.js).
 *
 * Fluxo (Authorization Code):
 *   app → GET /auth/google/redirect?drive=1&hint=…  → Google
 *   Google → GET /auth/google/callback?code=…&state=…
 *   API cria/encontra o colaborador pelo e-mail, emite o token do Sanctum e
 *   manda o navegador de volta para o app com tudo no fragmento da URL.
 *
 * O `state` vai assinado com a APP_KEY: a API não usa sessão, então é ele
 * que carrega "quero Drive" e protege contra callback forjado.
 */
class GoogleOAuth
{
    private const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

    private const TOKEN_URL = 'https://oauth2.googleapis.com/token';

    private const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

    private const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive';

    public function configurado(): bool
    {
        return (bool) (config('petermann.google.client_id') && config('petermann.google.client_secret'));
    }

    public function urlDeAutorizacao(string $redirectUri, bool $drive, ?string $loginHint): string
    {
        $scopes = ['openid', 'email', 'profile'];
        if ($drive) {
            $scopes[] = self::SCOPE_DRIVE;
        }

        $params = [
            'client_id' => config('petermann.google.client_id'),
            'redirect_uri' => $redirectUri,
            'response_type' => 'code',
            'scope' => implode(' ', $scopes),
            'access_type' => 'online',
            'include_granted_scopes' => 'true',
            'state' => $this->assinarState(['drive' => $drive, 'n' => bin2hex(random_bytes(8)), 'exp' => time() + 600]),
        ];
        if ($loginHint) {
            $params['login_hint'] = $loginHint;
        }

        return self::AUTH_URL.'?'.http_build_query($params);
    }

    /** @return array{access_token:string, expires_in:int, scope:string} */
    public function trocarCode(string $code, string $redirectUri): array
    {
        $r = Http::asForm()->timeout(15)->post(self::TOKEN_URL, [
            'code' => $code,
            'client_id' => config('petermann.google.client_id'),
            'client_secret' => config('petermann.google.client_secret'),
            'redirect_uri' => $redirectUri,
            'grant_type' => 'authorization_code',
        ]);
        if (! $r->ok() || ! $r->json('access_token')) {
            throw new RuntimeException('Google não devolveu o token: '.($r->json('error_description') ?: $r->status()));
        }

        return $r->json();
    }

    /** @return array{sub:string, email:string, email_verified:bool, name?:string} */
    public function userInfo(string $accessToken): array
    {
        $r = Http::withToken($accessToken)->timeout(15)->get(self::USERINFO_URL);
        if (! $r->ok() || ! $r->json('email')) {
            throw new RuntimeException('Google não devolveu o e-mail da conta');
        }

        return $r->json();
    }

    public function assinarState(array $dados): string
    {
        $json = base64_encode(json_encode($dados));
        $mac = hash_hmac('sha256', $json, (string) config('app.key'));

        return rtrim(strtr($json, '+/', '-_'), '=').'.'.$mac;
    }

    /** Devolve os dados do state ou null se a assinatura/validade falhar. */
    public function lerState(?string $state): ?array
    {
        if (! $state || ! str_contains($state, '.')) {
            return null;
        }
        [$b64, $mac] = explode('.', $state, 2);
        $json = strtr($b64, '-_', '+/');
        $json .= str_repeat('=', (4 - strlen($json) % 4) % 4);
        if (! hash_equals(hash_hmac('sha256', $json, (string) config('app.key')), $mac)) {
            return null;
        }
        $dados = json_decode(base64_decode($json), true);
        if (! is_array($dados) || ($dados['exp'] ?? 0) < time()) {
            return null;
        }

        return $dados;
    }
}
