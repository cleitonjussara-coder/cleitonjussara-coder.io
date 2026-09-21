<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Número e série da nota (pedido em 16/09/2026). Com chave de 44 dígitos os
 * dois já estão nela: série = posições 23–25, número = 26–34. NFS-e e
 * recibos: vêm do OCR ou digitados.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('notas', function (Blueprint $table) {
            $table->string('numero', 20)->nullable()->after('documento');
            $table->string('serie', 5)->nullable()->after('numero');
        });

        DB::table('notas')->whereNull('numero')->whereRaw('length(chave_nfce) = 44')->update([
            'numero' => DB::raw("ltrim(substr(chave_nfce, 26, 9), '0')"),
            'serie' => DB::raw("ltrim(substr(chave_nfce, 23, 3), '0')"),
        ]);
    }

    public function down(): void
    {
        Schema::table('notas', function (Blueprint $table) {
            $table->dropColumn(['numero', 'serie']);
        });
    }
};
