<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* Histórico por nota (06/11/2026, pedido do dono): quem mudou o quê em cada nota, com antes e depois. Até aqui só havia
   log de texto no servidor. Só registra daqui para a frente: nada é reconstruído para trás.

   Uma linha por alteração. `campos` é JSON {"valor":{"antes":100,"depois":120}}, com o valor cru: o rótulo legível (R$,
   nome no lugar do id) sai na leitura, em App\Services\HistoricoNota.
   `alterado_papel` guarda o papel NA HORA da mudança: quem é admin hoje vira colaborador em produção, e ler o papel atual
   mudaria o passado. O nome NÃO é guardado: sai do cadastro na leitura, e quem foi excluído some do histórico dos outros.
   Sem chave estrangeira para a nota: ela pode ser apagada de vez e o histórico é justamente a prova de quem apagou.

   Aditiva: tabela nova, nada existente muda. A API nova roda antes da migração (NotaHistorico::tabelaExiste). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('notas_historico', function (Blueprint $t) {
            $t->id();
            $t->string('nota_id')->index();
            $t->string('acao', 20);                          // criacao, edicao, tipo, lixeira, restaurada, anexo, dono, exclusao
            $t->text('campos');                              // JSON: {"campo":{"antes":…,"depois":…}}
            $t->string('alterado_por')->nullable();          // id de quem mudou; sem chave estrangeira, a pessoa pode ser excluída
            $t->string('alterado_papel', 20)->nullable();    // papel dessa pessoa naquele momento
            $t->timestamp('alterado_em')->index();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('notas_historico');
    }
};
