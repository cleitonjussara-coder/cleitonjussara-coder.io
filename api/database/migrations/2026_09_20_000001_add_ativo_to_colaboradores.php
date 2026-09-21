<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Colaborador desativado (20/09/2026): não entra, some das listas, mas os
 *  lançamentos dele continuam no histórico. Excluir de vez é outra ação e
 *  exige DUAS pessoas (gestor/admin): quem pediu fica em exclusao_pedida_por;
 *  outra pessoa confirma e aí apaga tudo. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('colaboradores', function (Blueprint $table) {
            $table->boolean('ativo')->default(true)->after('foto_path');
            $table->timestamp('desativado_em')->nullable()->after('ativo');
            $table->char('exclusao_pedida_por', 36)->nullable()->after('desativado_em');
            $table->timestamp('exclusao_pedida_em')->nullable()->after('exclusao_pedida_por');
        });
    }

    public function down(): void
    {
        Schema::table('colaboradores', function (Blueprint $table) {
            $table->dropColumn(['ativo', 'desativado_em', 'exclusao_pedida_por', 'exclusao_pedida_em']);
        });
    }
};
