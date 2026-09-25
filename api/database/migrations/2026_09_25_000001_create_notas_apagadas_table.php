<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* A lápide do "apagar em definitivo" (25/09/2026).

   Até aqui o destroy tirava a linha da tabela. Como o sync é incremental
   (where updated_at >= since), uma linha que sumiu nunca mais aparece na
   consulta — e os outros aparelhos ficavam com a cópia local para sempre.
   Foi o que aconteceu com uma nota da PANIFICADORA JOSPINA: apagada no
   servidor, continuava na faixa de pendências do gestor.

   Guardar só o id resolve: o app pergunta quais ids foram apagados desde a
   última sincronização e limpa os seus. Nenhum dado da nota fica aqui. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('notas_apagadas', function (Blueprint $t) {
            $t->string('id')->primary();          // o id da nota que se foi
            $t->string('user_id')->nullable();    // de quem era, para o filtro por visibilidade
            $t->string('apagada_por')->nullable();
            $t->timestamp('apagada_em')->useCurrent();
            $t->index('apagada_em');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('notas_apagadas');
    }
};
