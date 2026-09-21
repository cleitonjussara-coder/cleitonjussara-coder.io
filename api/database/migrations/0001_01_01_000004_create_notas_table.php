<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* Notas de despesa (RDA / RDM). Só o CAMINHO do anexo vai para o banco
   (foto_path = "<user_id>/<nota_id>.<ext>", relativo à pasta de fotos no
   disco do servidor). O arquivo em si nunca entra no MySQL. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('notas', function (Blueprint $table) {
            $table->char('id', 36)->primary();
            $table->char('user_id', 36);
            $table->char('created_by', 36)->nullable();
            $table->char('updated_by', 36)->nullable();
            $table->string('tipo', 3);                        // RDA | RDM
            $table->string('subtipo', 20)->nullable();        // Abastecimento | Hospedagem | Outros
            $table->char('cnpj', 14)->nullable();
            $table->string('razao_social')->nullable();
            $table->decimal('valor', 12, 2)->default(0);
            $table->date('data');
            $table->unsignedTinyInteger('mes');
            $table->unsignedSmallInteger('ano');
            $table->string('metodo_captura', 20)->default('manual');
            $table->char('chave_nfce', 44)->nullable();
            $table->char('uf', 2)->nullable();
            $table->char('modelo', 2)->nullable();
            $table->string('foto_path')->nullable();
            $table->text('qr_url')->nullable();
            $table->text('observacao')->nullable();
            $table->boolean('deleted')->default(false);
            $table->timestamps();

            $table->foreign('user_id')->references('id')->on('colaboradores')->cascadeOnDelete();
            $table->foreign('created_by')->references('id')->on('colaboradores')->nullOnDelete();
            $table->foreign('updated_by')->references('id')->on('colaboradores')->nullOnDelete();
            $table->index('user_id', 'idx_notas_uid');
            $table->index(['ano', 'mes'], 'idx_notas_anomes');
            $table->index('updated_at', 'idx_notas_upd');
            $table->index('chave_nfce', 'idx_notas_chave');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('notas');
    }
};
