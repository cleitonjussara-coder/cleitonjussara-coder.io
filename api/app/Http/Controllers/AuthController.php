<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Services\GoogleOAuth;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Password;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Cadastro, login e senha — o que era o Supabase Auth.
 * Token de acesso: Sanctum (Bearer), guardado pelo app no aparelho.
 */
class AuthController extends Controller
{
    /* ── e-mail / senha ─────────────────────────────────────── */

    public function register(Request $r): JsonResponse
    {
        $d = $r->validate([
            'nome' => ['nullable', 'string', 'max:120'],
            'email' => ['required', 'email', 'max:190', 'unique:colaboradores,email'],
            'password' => ['required', 'string', 'min:6', 'max:200'],
        ]);

        $user = Colaborador::create([
            'id' => (string) Str::uuid(),
            'nome' => trim($d['nome'] ?? '') ?: Str::before($d['email'], '@'),
            'email' => strtolower($d['email']),
            'password' => $d['password'],
        ]);

        return $this->sessao($user, 201);
    }

    public function login(Request $r): JsonResponse
    {
        $d = $r->validate([
            'email' => ['required', 'email'],
            'password' => ['required', 'string'],
        ]);

        $user = Colaborador::where('email', strtolower($d['email']))->first();
        if ($user && ! $user->ativo) {
            throw ValidationException::withMessages(['email' => 'Conta desativada. Fale com o gestor ou o administrador.']);
        }
        if (! $user || ! $user->password || ! Hash::check($d['password'], $user->password)) {
            /* Mensagem única de propósito: não revela se o e-mail existe. */
            throw ValidationException::withMessages(['email' => 'E-mail ou senha incorretos']);
        }

        /* Hash antigo do Supabase ($2a$10$…): o PHP valida igual, mas
           aproveita para regravar no custo atual. */
        if (Hash::needsRehash($user->password)) {
            $user->forceFill(['password' => $d['password']])->save();
        }

        return $this->sessao($user);
    }

    public function logout(Request $r): JsonResponse
    {
        $r->user()?->currentAccessToken()?->delete();

        return response()->json(['ok' => true]);
    }

    public function me(Request $r): JsonResponse
    {
        /* desativado com token ainda no aparelho: derruba a sessão */
        if (! $r->user()->ativo) {
            $r->user()->tokens()->delete();
            abort(401, 'Conta desativada');
        }

        return response()->json($r->user());
    }

    public function updateMe(Request $r): JsonResponse
    {
        $d = $r->validate(['nome' => ['required', 'string', 'max:120']]);
        $r->user()->update(['nome' => trim($d['nome'])]);

        return response()->json($r->user()->fresh());
    }

    /** POST /me/foto (multipart file) — foto do perfil; DELETE /me/foto remove. */
    public function fotoPerfil(Request $r, \App\Services\FotoStorage $fotos): JsonResponse
    {
        $u = $r->user();
        $r->validate(['file' => ['required', 'file', 'image', 'max:'.config('petermann.foto_max_kb')]]);
        $path = $fotos->salvarPara($u->id, 'perfil', $r->file('file'), $r->input('ext'));
        $u->forceFill(['foto_path' => $path])->save();

        return response()->json($u->fresh());
    }

    public function removerFotoPerfil(Request $r, \App\Services\FotoStorage $fotos): JsonResponse
    {
        $u = $r->user();
        $fotos->apagarVersoesDe($u->id, 'perfil');
        $u->forceFill(['foto_path' => null])->save();

        return response()->json($u->fresh());
    }

    /* ── recuperação de senha ───────────────────────────────── */

    public function forgot(Request $r): JsonResponse
    {
        $d = $r->validate(['email' => ['required', 'email']]);
        try {
            Password::sendResetLink(['email' => strtolower($d['email'])]);
        } catch (Throwable $e) {
            Log::warning('reset de senha: '.$e->getMessage());
        }

        /* Resposta genérica sempre: dizer "não cadastrado" revelaria quem
           tem conta para qualquer um que digite endereços na tela. */
        return response()->json(['ok' => true]);
    }

    public function reset(Request $r): JsonResponse
    {
        $d = $r->validate([
            'email' => ['required', 'email'],
            'token' => ['required', 'string'],
            'password' => ['required', 'string', 'min:6', 'max:200'],
        ]);

        $status = Password::reset(
            ['email' => strtolower($d['email']), 'token' => $d['token'], 'password' => $d['password']],
            function (Colaborador $user, string $password) {
                $user->forceFill(['password' => $password])->save();
                $user->tokens()->delete();          // derruba as sessões antigas
            }
        );

        if ($status !== Password::PASSWORD_RESET) {
            throw ValidationException::withMessages(['token' => 'O link expirou ou já foi usado — peça outro.']);
        }

        return response()->json(['ok' => true]);
    }

    /* ── Google ─────────────────────────────────────────────── */

    public function googleRedirect(Request $r, GoogleOAuth $g): RedirectResponse
    {
        if (! $g->configurado()) {
            /* Volta para o app com o erro: é uma navegação do navegador, não
               um fetch — um JSON aqui deixaria a pessoa presa nesta página. */
            return redirect()->away(config('petermann.front_url').'/#auth_error=indisponivel');
        }
        $url = $g->urlDeAutorizacao(
            route('auth.google.callback'),
            $r->boolean('drive'),
            $r->string('hint')->toString() ?: null,
        );

        return redirect()->away($url);
    }

    public function googleCallback(Request $r, GoogleOAuth $g): RedirectResponse
    {
        $front = config('petermann.front_url').'/';
        $state = $g->lerState($r->query('state'));

        if (! $state || $r->query('error') || ! $r->query('code')) {
            $motivo = $r->query('error') === 'access_denied' ? 'cancelado' : 'invalido';

            return redirect()->away($front.'#auth_error='.$motivo);
        }

        try {
            $tok = $g->trocarCode($r->query('code'), route('auth.google.callback'));
            $info = $g->userInfo($tok['access_token']);
        } catch (Throwable $e) {
            Log::warning('google callback: '.$e->getMessage());

            return redirect()->away($front.'#auth_error=google');
        }

        $email = strtolower($info['email']);
        $user = Colaborador::where('google_id', $info['sub'])->first()
            ?? Colaborador::where('email', $email)->first();

        if (! $user) {
            /* Primeiro acesso pelo Google: cria o perfil (era o gatilho
               handle_new_user), nome vindo do Google ou do e-mail. */
            $user = Colaborador::create([
                'id' => (string) Str::uuid(),
                'nome' => trim($info['name'] ?? '') ?: Str::before($email, '@'),
                'email' => $email,
                'google_id' => $info['sub'],
                'email_verified_at' => now(),
            ]);
        } elseif (! $user->google_id) {
            $user->forceFill(['google_id' => $info['sub'], 'email_verified_at' => $user->email_verified_at ?? now()])->save();
        }
        if (! $user->ativo) {
            return redirect()->away($front.'#auth_error=desativada');
        }

        $frag = [
            'token' => $user->createToken('google')->plainTextToken,
        ];
        /* Token do Google só vai ao app se o escopo do Drive foi pedido e
           concedido: é o que deixa gestor/admin entrar já com o Drive ligado. */
        $driveOk = ! empty($state['drive']) && str_contains($tok['scope'] ?? '', 'auth/drive');
        if ($driveOk) {
            $frag['google_token'] = $tok['access_token'];
            $frag['google_exp'] = time() + (int) ($tok['expires_in'] ?? 3300);
        }
        /* sem segredos: só para saber por que o Drive não veio (16/09/2026) */
        Log::info('google callback', ['email' => $email, 'drive_pedido' => ! empty($state['drive']), 'drive_concedido' => $driveOk, 'scope' => $tok['scope'] ?? '']);

        return redirect()->away($front.'#'.http_build_query($frag));
    }

    /* ── helpers ────────────────────────────────────────────── */

    private function sessao(Colaborador $user, int $status = 200): JsonResponse
    {
        return response()->json([
            'token' => $user->createToken('app')->plainTextToken,
            'user' => $user,
        ], $status);
    }
}
