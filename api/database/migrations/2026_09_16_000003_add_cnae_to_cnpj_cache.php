<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** CNAE principal do fornecedor — base da sugestão automática de aba (RDA/RDM). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('cnpj_cache', function (Blueprint $table) {
            $table->string('cnae', 7)->nullable()->after('nome_fantasia');
            $table->string('cnae_descricao', 160)->nullable()->after('cnae');
        });
    }

    public function down(): void
    {
        Schema::table('cnpj_cache', function (Blueprint $table) {
            $table->dropColumn(['cnae', 'cnae_descricao']);
        });
    }
};
