<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* Fechamento de mês (06/11/2026, decisão do dono): a planilha entregue à contabilidade não pode mudar por baixo dela, e a fila
   de quem está em campo não pode travar por causa disso.

   meses_fechados: uma linha por mês fechado da EMPRESA INTEIRA (não é por colaborador). Reabrir apaga a linha.
   meses_fechados_historico: quem fechou e reabriu, quando e por quê. Fica para sempre, sem chave estrangeira: a pessoa pode ser
   excluída e isto é a prova. `feito_papel` guarda o papel NA HORA, pelo mesmo motivo do histórico da nota.
   notas.fora_fechamento_em: nota NOVA que chegou de um aparelho com data de mês fechado. Ela entra (nunca é recusada) e a gestão
   confere; fora_conferida_em/por dizem quem conferiu. fora_avisada_em diz qual já saiu em push: o que ficou sem aviso é o que
   falta avisar, e a maior delas marca a janela. Nenhuma das quatro vai no $fillable: só o servidor escreve.

   Aditiva: nada existente muda e as colunas são nullable. A API nova roda antes da migração sem bloquear nada
   (MesFechado::tabelaExiste e Nota::temForaFechamento). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('meses_fechados', function (Blueprint $t) {
            $t->id();
            $t->unsignedSmallInteger('ano');
            $t->unsignedTinyInteger('mes');
            $t->timestamp('fechado_em');
            $t->string('fechado_por')->nullable();
            $t->unique(['ano', 'mes']);
        });

        Schema::create('meses_fechados_historico', function (Blueprint $t) {
            $t->id();
            $t->unsignedSmallInteger('ano');
            $t->unsignedTinyInteger('mes');
            $t->string('acao', 10);                        // fechar, reabrir
            $t->text('motivo')->nullable();                // obrigatório ao reabrir
            $t->string('feito_por')->nullable();
            $t->string('feito_papel', 20)->nullable();
            $t->timestamp('feito_em')->index();
            $t->index(['ano', 'mes']);
        });

        Schema::table('notas', function (Blueprint $t) {
            $t->timestamp('fora_fechamento_em')->nullable()->index();
            $t->timestamp('fora_conferida_em')->nullable();
            $t->string('fora_conferida_por')->nullable();
            $t->timestamp('fora_avisada_em')->nullable()->index();
        });
    }

    public function down(): void
    {
        Schema::table('notas', function (Blueprint $t) {
            $t->dropIndex(['fora_fechamento_em']);
            $t->dropIndex(['fora_avisada_em']);
            $t->dropColumn(['fora_fechamento_em', 'fora_conferida_em', 'fora_conferida_por', 'fora_avisada_em']);
        });
        Schema::dropIfExists('meses_fechados_historico');
        Schema::dropIfExists('meses_fechados');
    }
};
