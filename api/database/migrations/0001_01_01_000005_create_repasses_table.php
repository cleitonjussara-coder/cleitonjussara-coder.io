<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('repasses', function (Blueprint $table) {
            $table->char('id', 36)->primary();
            $table->char('user_id', 36);
            $table->string('tipo', 3);                         // RDA | RDM
            $table->decimal('valor', 12, 2)->default(0);
            $table->date('data');
            $table->unsignedTinyInteger('mes');
            $table->unsignedSmallInteger('ano');
            $table->text('descricao')->nullable();
            $table->string('kind', 10)->default('received');   // received | requested
            $table->boolean('email_sent')->default(false);
            $table->boolean('deleted')->default(false);
            $table->timestamps();

            $table->foreign('user_id')->references('id')->on('colaboradores')->cascadeOnDelete();
            $table->index('user_id', 'idx_rep_uid');
            $table->index(['ano', 'mes'], 'idx_rep_anomes');
            $table->index('updated_at', 'idx_rep_upd');
        });

        /* Registro de cada e-mail de solicitação de repasse (auditoria e
           depuração), no lugar da tabela alimentada pelo gatilho pg_net. */
        Schema::create('repasse_emails', function (Blueprint $table) {
            $table->char('id', 36)->primary();
            $table->char('repasse_id', 36);
            $table->string('provider_id', 100)->nullable();    // id devolvido pelo Resend
            $table->text('erro')->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->foreign('repasse_id')->references('id')->on('repasses')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('repasse_emails');
        Schema::dropIfExists('repasses');
    }
};
