<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Unificar Reembolso e Repasse (25/09/2026).
 *
 * Reembolso (regime CV) e Repasse (regime RDM/RDA) sempre foram a mesma
 * coisa — dinheiro que a empresa transfere para a CONTA/CARTEIRA do
 * colaborador — só com nome diferente conforme o regime. Na tela isso já
 * virou "Repasse" para os dois; esta migração acompanha na gravação:
 * o valor 'reembolso' vira 'carteira' em notas.pagamento e repasses.destino.
 * 'recarga' (dinheiro que vai para o CARTÃO, não para a pessoa) não muda —
 * continua sendo um caminho à parte.
 */
return new class extends Migration
{
    public function up(): void
    {
        $n = DB::table('notas')->where('pagamento', 'reembolso')->update(['pagamento' => 'carteira']);
        echo "  notas.pagamento 'reembolso' -> 'carteira': {$n}\n";

        $r = DB::table('repasses')->where('destino', 'reembolso')->update(['destino' => 'carteira']);
        echo "  repasses.destino 'reembolso' -> 'carteira': {$r}\n";
    }

    public function down(): void
    {
        DB::table('notas')->where('pagamento', 'carteira')->update(['pagamento' => 'reembolso']);
        DB::table('repasses')->where('destino', 'carteira')->update(['destino' => 'reembolso']);
    }
};
