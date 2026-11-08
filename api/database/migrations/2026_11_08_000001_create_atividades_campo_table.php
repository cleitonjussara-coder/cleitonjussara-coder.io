<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Atividade em campo (08/11/2026, pedido do Cleiton e da equipe da Syngenta): em vez de escrever no grupo do WhatsApp
 * "Início das atividades / Faz. São José / BRCB147A-B" e depois "Fim das atividades", a pessoa toca um botão no app.
 * Cada linha é UMA atividade: fazenda, campo, hora de início e de fim e a localização do aparelho em cada toque. Serve de
 * controle de segurança (último campo e última localização de quem passou mal) e de relatório para o gestor.
 *
 * Localização: o Cleiton autorizou gravar (08/11/2026), revertendo para ESTA função o que foi decidido para o ponto em
 * 04/11/2026. A política de privacidade foi atualizada no mesmo build. Só se coleta no toque, nunca em segundo plano.
 *
 * Quem usa: o gestor liga a função por pessoa (colaboradores.atividade_campo). Para os outros ela fica oculta.
 * O id é UUID gerado no aparelho: o toque feito sem internet sobe depois sem duplicar.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('atividades_campo', function (Blueprint $table) {
            $table->char('id', 36)->primary();
            $table->char('user_id', 36)->index();
            $table->string('fazenda', 120);
            $table->string('campo', 60);
            $table->dateTime('inicio');                         // hora de Brasília
            $table->dateTime('fim')->nullable();                // null = ainda em campo
            $table->boolean('fim_automatico')->default(false);  // fechada porque a pessoa iniciou outro campo
            $table->decimal('lat_inicio', 10, 7)->nullable();
            $table->decimal('lng_inicio', 10, 7)->nullable();
            $table->unsignedInteger('precisao_inicio')->nullable();   // metros, como o aparelho informou
            $table->decimal('lat_fim', 10, 7)->nullable();
            $table->decimal('lng_fim', 10, 7)->nullable();
            $table->unsignedInteger('precisao_fim')->nullable();
            $table->string('observacao', 500)->nullable();
            $table->timestamps();
            $table->index(['user_id', 'inicio']);
        });

        Schema::table('colaboradores', function (Blueprint $table) {
            $table->boolean('atividade_campo')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('colaboradores', function (Blueprint $table) {
            $table->dropColumn('atividade_campo');
        });
        Schema::dropIfExists('atividades_campo');
    }
};
