<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* Aviso para corrigir nota (24/10/2026, pedido do Cleiton): no quadro "O que falta corrigir" o gestor/admin
   toca em "Avisar" e o dono da nota recebe uma notificação (celular + sino + e-mail) para corrigi-la.

   Uma linha por aviso. Diferente da justificativa, não há resposta em texto: o aviso sai do sino quando o
   colaborador toca em "OK, vi" (visto_em) ou quando a nota deixa de ter pendência — nesse caso o app só ESCONDE
   o aviso (confere com a cópia local da nota), não grava nada.
   Os dados da nota ficam copiados (nota_titulo, nota_data, nota_valor) para o sino mostrar o aviso mesmo
   que o aparelho ainda não tenha a nota.
   `agrupado`: o aviso entrou no sino mas NÃO gerou celular nem e-mail, porque o mesmo colaborador acabara de
   receber outro (evita 8 vibrações e 8 e-mails quando o gestor avisa nota por nota).

   Aditiva: tabela nova, nada existente muda — o app antigo continua funcionando. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('avisos_correcao', function (Blueprint $t) {
            $t->string('id')->primary();
            $t->string('nota_id');                     // a nota a corrigir
            $t->string('colaborador_id');              // dono da nota (quem recebe)
            $t->string('pedido_por')->nullable();      // gestor/admin que avisou
            $t->text('motivos');                       // JSON: ["sem CNPJ", "foto em branco"]
            $t->text('mensagem')->nullable();          // texto livre do gestor
            $t->string('nota_titulo', 160)->nullable();
            $t->string('nota_data', 10)->nullable();   // AAAA-MM-DD
            $t->double('nota_valor')->nullable();
            $t->timestamp('visto_em')->nullable();     // o colaborador deu "OK, vi"
            $t->boolean('agrupado')->default(false);   // só sino: celular e e-mail já tinham saído há pouco
            $t->boolean('email_enviado')->default(false);
            $t->string('email_erro')->nullable();
            $t->timestamps();
            $t->index(['nota_id', 'created_at']);
            $t->index(['colaborador_id', 'visto_em']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('avisos_correcao');
    }
};
