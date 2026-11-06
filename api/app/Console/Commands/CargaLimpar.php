<?php

namespace App\Console\Commands;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\FotoStorage;
use Illuminate\Console\Command;

/**
 * php84 artisan carga:limpar
 *
 * Remove tudo que o teste de carga criou: usuários *@carga.test, as notas e
 * os anexos deles, e o arquivo de tokens. Só toca em quem tem esse e-mail.
 */
class CargaLimpar extends Command
{
    protected $signature = 'carga:limpar';

    protected $description = 'Apaga usuários, notas e anexos criados pelo teste de carga';

    public function handle(FotoStorage $fotos): int
    {
        if (app()->environment('production')) {
            $this->error('Recusado: este ambiente é produção.');

            return self::FAILURE;
        }

        $ids = Colaborador::where('email', 'like', '%@carga.test')->pluck('id')->all();
        foreach ($ids as $id) {
            $fotos->disk()->deleteDirectory($id);
        }
        /* 06/11/2026: as notas do teste passam pelo PUT e ganham histórico, que não pode sobrar na homologação */
        if (\App\Models\NotaHistorico::tabelaExiste()) {
            \App\Models\NotaHistorico::whereIn('nota_id', Nota::whereIn('user_id', $ids)->select('id'))->delete();
        }
        $notas = Nota::whereIn('user_id', $ids)->delete();
        foreach ($ids as $id) {
            Colaborador::find($id)?->tokens()->delete();
        }
        $usuarios = Colaborador::whereIn('id', $ids)->delete();
        @unlink(storage_path('app/carga-tokens.json'));

        $this->info("Removidos: {$usuarios} usuários, {$notas} notas.");

        return self::SUCCESS;
    }
}
