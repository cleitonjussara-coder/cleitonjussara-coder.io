<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Aparelhos inscritos para receber notificação (24/09/2026).
 *
 * O Cleiton pediu o número no ícone do app, como o do PicPay. No Android o
 * app não desenha esse número: o sistema o põe sozinho quando há notificação
 * NÃO LIDA (a API de badge do navegador só existe no Windows e no macOS).
 * Então o caminho é notificação de verdade — Web Push.
 *
 * Cada aparelho gera uma inscrição (endpoint + duas chaves). Uma pessoa pode
 * ter vários: celular, tablet, computador. O endpoint é único e é ele que o
 * serviço de push usa como endereço.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('push_subscriptions', function (Blueprint $table) {
            $table->id();
            $table->char('user_id', 36);
            $table->text('endpoint');
            $table->string('endpoint_hash', 64)->unique();   // sha256 do endpoint: TEXT não aceita índice único
            $table->string('p256dh', 120);
            $table->string('auth', 60);
            $table->string('aparelho', 120)->nullable();
            $table->timestamps();

            $table->foreign('user_id')->references('id')->on('colaboradores')->cascadeOnDelete();
            $table->index('user_id', 'idx_push_uid');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('push_subscriptions');
    }
};
