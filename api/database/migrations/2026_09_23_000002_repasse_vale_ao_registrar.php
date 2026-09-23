<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Repasse volta a valer no momento do registro (23/09/2026).
 *
 * A confirmação do colaborador, criada mais cedo no mesmo dia pela migração
 * 2026_09_23_000001, saiu do fluxo: quem paga é o gestor, e o que ele
 * registra já entra no saldo, no gráfico e na planilha.
 *
 * As colunas confirmado_em/confirmado_por FICAM — passam a guardar quem
 * registrou e quando, que é o histórico que os relatórios já leem
 * (whereNotNull('confirmado_em')). Aqui só liberamos o que ficou parado
 * esperando um "recebi" que não será mais pedido.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pendentes = DB::table('repasses')
            ->whereNull('confirmado_em')
            ->where('deleted', false)
            ->where(function ($q) {
                $q->where('kind', 'received')->orWhereNull('kind');
            });

        $quantos = (clone $pendentes)->count();
        $pendentes->update(['confirmado_em' => now()]);

        if ($quantos) {
            echo "  repasses que estavam esperando confirmação e agora valem: {$quantos}\n";
        }
    }

    public function down(): void
    {
        /* Sem volta: não dá para saber quais repasses estavam pendentes antes
           desta migração, e apagar confirmado_em tiraria do saldo repasses
           legítimos. A migração 000001 continua sendo a que cria as colunas. */
    }
};
