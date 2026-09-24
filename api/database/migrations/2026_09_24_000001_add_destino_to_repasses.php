<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Recarga do cartão x reembolso (24/09/2026).
 *
 * No regime de cartão corporativo o dinheiro anda por dois caminhos, e a
 * planilha da empresa os guarda em colunas diferentes do BANCO DE DADOS:
 *
 *   • RECARGA  → "EXTRATO DE VALOR RECEBIDO/RECARGA ALELO" (B/C): valor
 *     transferido para o cartão pré-pago. É dele que sai o saldo do cartão.
 *   • REEMBOLSO → "REEMBOLSO DE:" (I/J): o que a empresa devolve ao
 *     colaborador pelas notas que ele pagou do próprio bolso.
 *
 * Até aqui tudo era tratado como reembolso, e a coluna da recarga saía
 * vazia. `destino` fica NULL para quem é RDM/RDA, onde a distinção não faz
 * sentido — lá o repasse recebido alimenta as duas colunas, como sempre.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('repasses', function (Blueprint $table) {
            $table->string('destino', 12)->nullable()->after('kind');   // recarga | reembolso
        });

        /* O que já existe de CV era, na prática, reembolso: é assim que o
           relatório vinha tratando. Marcar agora evita que um lançamento
           antigo apareça como recarga e infle o saldo do cartão. */
        $idsCv = DB::table('colaboradores')->where('regime', 'cv')->pluck('id');
        if ($idsCv->isNotEmpty()) {
            $n = DB::table('repasses')->whereIn('user_id', $idsCv)->whereNull('destino')
                ->update(['destino' => 'reembolso']);
            echo "  repasses de CV marcados como reembolso: {$n}\n";
        }
    }

    public function down(): void
    {
        Schema::table('repasses', fn (Blueprint $t) => $t->dropColumn('destino'));
    }
};
