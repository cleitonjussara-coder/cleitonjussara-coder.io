<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* Cache de razão social por CNPJ (evita consultas repetidas à BrasilAPI). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('cnpj_cache', function (Blueprint $table) {
            $table->char('cnpj', 14)->primary();
            $table->string('razao_social')->nullable();
            $table->string('nome_fantasia')->nullable();
            $table->timestamp('consultado_em')->useCurrent();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('cnpj_cache');
    }
};
