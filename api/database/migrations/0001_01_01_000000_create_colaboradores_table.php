<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* Espelho de public.colaboradores do Supabase. O id continua sendo o UUID
   de lá (char(36)) para as notas e repasses migrados apontarem certo e para
   o app não precisar reindexar o IndexedDB de ninguém. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('colaboradores', function (Blueprint $table) {
            $table->char('id', 36)->primary();
            $table->string('nome')->default('');
            $table->string('email')->unique();
            $table->string('password')->nullable();            // null = só entra pelo Google
            $table->string('role', 20)->default('colaborador'); // colaborador | gestor | admin
            $table->string('nucleo', 60)->default('Cristalina');
            $table->string('google_id', 64)->nullable()->index();
            $table->timestamp('email_verified_at')->nullable();
            $table->rememberToken();
            $table->timestamps();
        });

        Schema::create('password_reset_tokens', function (Blueprint $table) {
            $table->string('email')->primary();
            $table->string('token');
            $table->timestamp('created_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('password_reset_tokens');
        Schema::dropIfExists('colaboradores');
    }
};
