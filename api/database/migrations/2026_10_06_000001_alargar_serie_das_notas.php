<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/* Troca para MySQL (06/10/2026, pedido do Cleiton). A API aceita `serie` com
   até 20 caracteres, mas a coluna nasceu com 5. O SQLite não confere tamanho
   e guardava tudo; o MySQL recusaria a nota inteira. Só alarga no MySQL: no
   SQLite o ->change() recriaria a tabela de notas à toa. */
return new class extends Migration
{
    public function up(): void
    {
        if (DB::connection()->getDriverName() === 'sqlite') {
            return;
        }
        Schema::table('notas', function (Blueprint $table) {
            $table->string('serie', 20)->nullable()->change();
        });
    }

    public function down(): void
    {
        if (DB::connection()->getDriverName() === 'sqlite') {
            return;
        }
        Schema::table('notas', function (Blueprint $table) {
            $table->string('serie', 5)->nullable()->change();
        });
    }
};
