<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Tipo do documento fiscal da nota — pedido em 16/09/2026 para diferenciar
 * NFC-e, NF-e, DANFE, NFS-e e recibos. Quando há chave de 44 dígitos o
 * modelo (posições 21–22) já diz: 65 = NFC-e, 55 = NF-e/DANFE.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('notas', function (Blueprint $table) {
            $table->string('documento', 8)->nullable()->after('modelo');
        });

        /* Preenche o que dá para saber pela chave; 55 vira 'nfe' (o app
           refina para DANFE quando o anexo é foto). Sem chave fica null e a
           pessoa escolhe ao editar. */
        DB::table('notas')->whereNull('documento')->whereRaw('length(chave_nfce) = 44')
            ->update(['documento' => DB::raw("case substr(chave_nfce, 21, 2) when '65' then 'nfce' when '55' then 'nfe' end")]);
    }

    public function down(): void
    {
        Schema::table('notas', function (Blueprint $table) {
            $table->dropColumn('documento');
        });
    }
};
