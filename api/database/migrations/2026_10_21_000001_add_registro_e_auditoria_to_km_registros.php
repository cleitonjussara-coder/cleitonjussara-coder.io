<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Histórico de KM (pedido do Cleiton, 21/10/2026).
 *
 * `registrado_em`: o momento em que a pessoa registrou a leitura, pelo relógio
 *   do aparelho corrigido com o do servidor. `created_at` é a hora em que o
 *   registro SUBIU — para o que foi feito sem internet isso é horas depois, e
 *   o histórico mostraria "17:42" para uma leitura das 07:55.
 * `atualizado_por`: quem mexeu por último no registro. O gestor passa a poder
 *   corrigir a leitura de outra pessoa (erro de digitação que distorce o
 *   ranking), e o detalhe diz "corrigido por fulano".
 * Índice em `data`: o painel e o histórico buscam por período em todos os veículos.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('km_registros', function (Blueprint $table) {
            $table->dateTime('registrado_em')->nullable();
            $table->char('atualizado_por', 36)->nullable();
            $table->index('data');
        });
    }

    public function down(): void
    {
        Schema::table('km_registros', function (Blueprint $table) {
            $table->dropIndex(['data']);
            $table->dropColumn(['registrado_em', 'atualizado_por']);
        });
    }
};
