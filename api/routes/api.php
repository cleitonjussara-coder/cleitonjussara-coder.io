<?php

use App\Http\Controllers\PushController;
use App\Http\Controllers\AdminController;
use App\Http\Controllers\ArquivosController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\BackupController;
use App\Http\Controllers\CnpjController;
use App\Http\Controllers\ColaboradorController;
use App\Http\Controllers\ConviteController;
use App\Http\Controllers\FotoController;
use App\Http\Controllers\FrotaController;
use App\Http\Controllers\NotaController;
use App\Http\Controllers\PontoController;
use App\Http\Controllers\RelatorioController;
use App\Http\Controllers\RepasseController;
use App\Http\Middleware\ExigeConfirmacao;
use App\Services\GoogleOAuth;
use Illuminate\Support\Facades\Route;

/* Todas as rotas ficam sob /api (prefixo padrão do Laravel). O app chama
   API_URL + caminho; ver rda-rdm-app/js/api.js. */

/* `google` diz ao app se o login Google está configurado — sem isto o app
   sairia para /auth/google/redirect e voltaria com erro. */
Route::get('/ping', fn () => [
    'ok' => true,
    'app' => config('app.name'),
    'hora' => now()->toIso8601String(),
    'google' => app(GoogleOAuth::class)->configurado(),
]);

/* ── sem token ─────────────────────────────────────────────── */
Route::prefix('auth')->group(function () {
    Route::post('/register', [AuthController::class, 'register'])->middleware('throttle:10,1');
    Route::get('/convites/{token}', [ConviteController::class, 'ver'])->middleware('throttle:30,1');   // público: a tela de cadastro mostra o convite
    Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:20,1');
    Route::post('/forgot', [AuthController::class, 'forgot'])->middleware('throttle:5,1');
    Route::post('/reset', [AuthController::class, 'reset'])->middleware('throttle:10,1');
    Route::get('/google/redirect', [AuthController::class, 'googleRedirect'])->name('auth.google.redirect');
    Route::get('/google/callback', [AuthController::class, 'googleCallback'])->name('auth.google.callback');
});

/* Anexo: assinatura temporária OU Bearer — o controller decide. */
Route::get('/fotos/{path}', [FotoController::class, 'show'])->where('path', '.*')->name('fotos.show');

/* ── com token (Sanctum) ───────────────────────────────────── */
Route::middleware(['auth:sanctum', ExigeConfirmacao::class])->group(function () {
    Route::post('/auth/logout', [AuthController::class, 'logout']);
    Route::get('/me', [AuthController::class, 'me']);
    Route::patch('/me', [AuthController::class, 'updateMe']);
    Route::post('/me/foto', [AuthController::class, 'fotoPerfil']);
    Route::delete('/me/foto', [AuthController::class, 'removerFotoPerfil']);

    Route::get('/colaboradores', [ColaboradorController::class, 'index']);
    Route::post('/convites', [ConviteController::class, 'criar']);
    Route::get('/convites', [ConviteController::class, 'lista']);
    Route::get('/colaboradores/{id}', [ColaboradorController::class, 'show']);
    Route::patch('/colaboradores/{id}', [ColaboradorController::class, 'update']);
    /* desativar / excluir colaborador (20/09/2026) */
    Route::patch('/colaboradores/{id}/ativo', [ColaboradorController::class, 'ativo']);
    Route::post('/colaboradores/{id}/confirmar', [ColaboradorController::class, 'confirmar']);   // libera entrada de cadastro novo (22/09/2026)
    Route::post('/colaboradores/{id}/excluir', [ColaboradorController::class, 'excluir']);
    Route::delete('/colaboradores/{id}/excluir', [ColaboradorController::class, 'cancelarExclusao']);

    Route::get('/notas', [NotaController::class, 'index']);
    Route::post('/notas/chave-existe', [NotaController::class, 'chaveExiste']);
    Route::post('/notas/existem', [NotaController::class, 'existem']);
    Route::post('/notas/consultar-qr', [NotaController::class, 'consultarQr']);
    Route::post('/notas/reparar-fotos', [NotaController::class, 'repararFotos']);
    Route::put('/notas/{id}', [NotaController::class, 'upsert']);
    Route::patch('/notas/{id}/tipo', [NotaController::class, 'corrigirTipo']);   // gestor corrige RDA⇄RDM (23/09/2026)
    Route::delete('/notas/{id}', [NotaController::class, 'destroy']);
    Route::post('/notas/{id}/foto', [NotaController::class, 'foto']);

    /* Notificação no celular (24/09/2026) */
    Route::get('/push/chave', [PushController::class, 'chave']);
    Route::post('/push/inscrever', [PushController::class, 'inscrever']);
    Route::delete('/push/inscrever', [PushController::class, 'desinscrever']);
    Route::post('/push/testar', [PushController::class, 'testar']);

    Route::get('/repasses', [RepasseController::class, 'index']);
    Route::put('/repasses/{id}', [RepasseController::class, 'upsert']);
    Route::patch('/repasses/{id}/atendido', [RepasseController::class, 'atendido']);     // 1ª etapa: gestor marca o pedido como pago (21/09/2026)
    Route::patch('/repasses/{id}/confirmar', [RepasseController::class, 'confirmar']);   // 2ª etapa: colaborador confirma o recebimento (23/09/2026)

    Route::post('/fotos/urls', [FotoController::class, 'urls']);

    Route::get('/relatorio/cv', [RelatorioController::class, 'cv']);
    Route::get('/relatorio/equipe', [RelatorioController::class, 'equipe']);
    Route::get('/relatorio/cv-equipe', [RelatorioController::class, 'cvEquipe']);
    Route::get('/relatorio/rdmrda', [RelatorioController::class, 'rdmrda']);   // modelo RDM/RDA da empresa (21/09/2026)

    /* arquivos no servidor, no lugar do Drive (19/09/2026) */
    Route::get('/arquivos/resumo', [ArquivosController::class, 'resumo']);
    Route::get('/arquivos/notas', [ArquivosController::class, 'notas']);
    Route::get('/arquivos/zip', [ArquivosController::class, 'zip']);
    Route::get('/backup/banco', [BackupController::class, 'banco']);
    Route::get('/backup/lista', [BackupController::class, 'lista']);
    Route::get('/backup/completo', [BackupController::class, 'completo']);
    Route::get('/backup/arquivo/{nome}', [BackupController::class, 'arquivo']);
    Route::get('/backup/drive', [BackupController::class, 'driveStatus']);          // cópia no Google Drive (21/09/2026)
    Route::get('/backup/drive/url', [BackupController::class, 'driveUrl']);
    Route::post('/backup/drive/enviar', [BackupController::class, 'driveEnviar']);
    Route::delete('/backup/drive', [BackupController::class, 'driveDesconectar']);
    Route::get('/admin/status', [AdminController::class, 'status']);
    Route::post('/admin/migrar', [AdminController::class, 'migrar']);
    Route::get('/admin/armazenamento', [AdminController::class, 'armazenamento']);   // monitoramento de disco (21/09/2026)

    /* frota: veículos + registros de km (16/09/2026) */
    Route::get('/veiculos', [FrotaController::class, 'veiculos']);
    Route::put('/veiculos/{id}', [FrotaController::class, 'veiculoUpsert']);
    Route::get('/km', [FrotaController::class, 'index']);
    Route::put('/km/{id}', [FrotaController::class, 'upsert']);
    Route::delete('/km/{id}', [FrotaController::class, 'destroy']);
    Route::post('/km/{id}/foto', [FrotaController::class, 'foto']);
    Route::get('/frota/resumo', [FrotaController::class, 'resumo']);
    Route::get('/frota/anual', [FrotaController::class, 'anual']);

    /* ponto de presença (18/09/2026) */
    Route::get('/ponto', [PontoController::class, 'index']);
    Route::post('/ponto/bater', [PontoController::class, 'bater']);
    Route::get('/ponto/resumo', [PontoController::class, 'resumo']);
    Route::put('/ponto/{id}', [PontoController::class, 'upsert']);
    Route::delete('/ponto/{id}', [PontoController::class, 'destroy']);
    Route::get('/feriados', [PontoController::class, 'feriados']);
    Route::put('/feriados', [PontoController::class, 'feriadoUpsert']);
    Route::delete('/feriados/{data}', [PontoController::class, 'feriadoDelete']);

    Route::get('/cnpj/{cnpj}', [CnpjController::class, 'show']);
    Route::put('/cnpj/{cnpj}', [CnpjController::class, 'upsert']);
});
