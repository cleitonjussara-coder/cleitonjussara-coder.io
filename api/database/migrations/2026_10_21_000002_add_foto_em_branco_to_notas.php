<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Foto sem dados de nota (21/10/2026).
 *
 * Um colaborador anexou uma foto de papel liso e a nota foi lançada normalmente. O servidor passa a medir o anexo
 * no envio (App\Services\FotoEmBranco) e guarda o resultado aqui:
 *   null  → ainda não analisada (nota antiga, ou anexo enviado antes desta versão)
 *   false → analisada: tem conteúdo (ou não é imagem que dê para medir: PDF, XML, HEIC)
 *   true  → analisada: a imagem está em branco
 * Só o servidor escreve (a coluna não é fillable). Nunca apaga nem bloqueia nada: vira pendência "foto em branco".
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('notas', function (Blueprint $table) {
            $table->boolean('foto_em_branco')->nullable()->after('foto_path');
        });
    }

    public function down(): void
    {
        Schema::table('notas', fn (Blueprint $t) => $t->dropColumn('foto_em_branco'));
    }
};
