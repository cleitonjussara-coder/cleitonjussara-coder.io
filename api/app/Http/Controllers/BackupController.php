<?php

namespace App\Http\Controllers;

use App\Services\BackupCompleto;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * Backup do banco (SQLite) para o admin baixar pelo app.
 *
 * A hospedagem compartilhada não faz backup de arquivo avulso, e o banco é
 * um arquivo: sem isto, o backup dependeria de alguém lembrar de baixar
 * database.sqlite pelo gerenciador. `VACUUM INTO` gera uma cópia íntegra
 * mesmo com gente gravando (não copia o -wal pela metade).
 */
class BackupController extends Controller
{
    public function __construct(private BackupCompleto $completo) {}

    /** GET /backup/lista — backups automáticos guardados no servidor (só admin). */
    public function lista(Request $r): JsonResponse
    {
        abort_unless($r->user()?->ehAdmin(), 403, 'Só o admin vê os backups');

        return response()->json(['backups' => $this->completo->listar()]);
    }

    /** GET /backup/completo — gera agora (banco + fotos) e baixa; não fica guardado. */
    public function completo(Request $r): BinaryFileResponse
    {
        abort_unless($r->user()?->ehAdmin(), 403, 'Só o admin baixa o backup');
        $tmp = tempnam(sys_get_temp_dir(), 'bk_').'.zip';
        $this->completo->gerar($tmp);

        return response()->download($tmp, 'petermann-completo-'.now(BackupCompleto::TZ)->format('Y-m-d').'.zip', ['Content-Type' => 'application/zip'])
            ->deleteFileAfterSend(true);
    }

    /** GET /backup/arquivo/{nome} — baixa um backup automático já guardado. */
    public function arquivo(Request $r, string $nome): BinaryFileResponse
    {
        abort_unless($r->user()?->ehAdmin(), 403, 'Só o admin baixa o backup');
        $p = $this->completo->caminhoDe($nome);
        abort_unless($p, 404, 'Backup não encontrado');

        return response()->download($p, $nome, ['Content-Type' => 'application/zip']);
    }

    /** GET /backup/banco — só admin, só SQLite. */
    public function banco(Request $r): BinaryFileResponse
    {
        abort_unless($r->user()?->ehAdmin(), 403, 'Só o admin baixa o backup');
        abort_unless(DB::connection()->getDriverName() === 'sqlite', 400, 'Backup por aqui só para SQLite');

        $tmp = storage_path('app/backup-'.now()->format('Ymd-His').'.sqlite');
        $this->completo->copiarBanco($tmp);   // VACUUM INTO ou SQLite3::backup (Locaweb tem SQLite 3.26)

        return response()
            ->download($tmp, 'petermann-'.now()->format('Y-m-d').'.sqlite', ['Content-Type' => 'application/vnd.sqlite3'])
            ->deleteFileAfterSend(true);
    }
}
