<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;

/**
 * Manutenção que na hospedagem compartilhada não dá para fazer por SSH.
 * Gestor e admin (22/09/2026). Tudo idempotente: chamar duas vezes não estraga nada.
 */
class AdminController extends Controller
{
    /** GET /admin/status — versão, banco, migrações pendentes. */
    public function status(Request $r): JsonResponse
    {
        abort_unless($r->user()?->manutencao(), 403, 'Só gestor ou admin acessa a manutenção do servidor');

        Artisan::call('migrate:status');
        $pendentes = collect(explode("\n", Artisan::output()))
            ->filter(fn ($l) => str_contains($l, 'Pending'))
            ->map(fn ($l) => trim(preg_replace('/\s+.*$/', '', trim($l))))
            ->values();

        return response()->json([
            'laravel' => app()->version(),
            'php' => PHP_VERSION,
            'banco' => DB::connection()->getDriverName(),
            'migracoes_pendentes' => $pendentes,
            'fotos_path' => config('filesystems.disks.fotos.root'),
        ]);
    }

    /**
     * GET /admin/armazenamento — quanto o app ocupa no servidor (banco, fotos,
     * backups, logs), último backup, histórico diário e tendência (21/09/2026).
     * Alimenta o cartão "Armazenamento" no Perfil do gestor/admin.
     */
    public function armazenamento(Request $r, \App\Services\Armazenamento $a): JsonResponse
    {
        abort_unless($r->user()?->manutencao(), 403, 'Só gestor ou admin acessa a manutenção do servidor');

        $m = $a->medir();
        $hist = $a->historico();
        if (! $hist || substr(end($hist)['em'], 0, 10) !== substr($m['em'], 0, 10)) {
            $a->registrar($m);   // abrir o cartão também vale como amostra do dia
            $hist = $a->historico();
        }
        $m['tendencia'] = $a->tendencia($hist, $m['limite_mb']);
        $m['historico'] = array_slice($hist, -90);
        $m['limites'] = ['aviso_pct' => config('petermann.armazenamento.aviso_pct'), 'critico_pct' => config('petermann.armazenamento.critico_pct')];

        return response()->json($m);
    }

    /**
     * POST /admin/migrar — roda as migrações pendentes NO SERVIDOR.
     * É o "php artisan migrate --force" de quem não tem terminal lá: o banco
     * (SQLite) é um arquivo na hospedagem, então a migração tem que rodar
     * nele, não no PC.
     */
    public function migrar(Request $r): JsonResponse
    {
        abort_unless($r->user()?->manutencao(), 403, 'Só gestor ou admin acessa a manutenção do servidor');

        $codigo = Artisan::call('migrate', ['--force' => true]);

        return response()->json([
            'ok' => $codigo === 0,
            'saida' => trim(Artisan::output()),
        ]);
    }
}
