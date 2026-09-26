<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* Auditoria de troca de papel/regime (26/09/2026, melhoria apontada no
   Raio-X do app): até aqui isso só ia pro storage/logs/laravel.log, texto
   que o gestor nunca vê — a tela Histórico (build 287) cobria nota e
   repasse, mas não isso. Uma linha por troca, igual ao espírito de
   notas_apagadas: guarda o mínimo, o Histórico junta com o resto. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('colaboradores_historico', function (Blueprint $t) {
            $t->string('id')->primary();
            $t->string('colaborador_id');           // de quem mudou
            $t->string('campo');                    // 'role' | 'regime'
            $t->string('de')->nullable();
            $t->string('para')->nullable();
            $t->string('alterado_por')->nullable();
            $t->timestamp('alterado_em')->useCurrent();
            $t->index(['alterado_em']);
            $t->index(['colaborador_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('colaboradores_historico');
    }
};
