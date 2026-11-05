<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * 04/11/2026, pedido do Cleiton: apaga a localização que o ponto gravava na entrada. Nenhuma tela usava, a coleta parou no
 * build 519, os pontos eram de teste e a política de privacidade diz que o app não coleta localização.
 *
 * Só esvazia lat e lng: horários e dias ficam como estão. As colunas ficam para aparelho antigo seguir enviando sem erro.
 * Sem updated_at de propósito: a API não devolve mais esses campos, então o aparelho não tem o que receber.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::table('pontos')
            ->where(fn ($q) => $q->whereNotNull('lat')->orWhereNotNull('lng'))
            ->update(['lat' => null, 'lng' => null]);
    }

    /** Sem volta: o valor antigo só existe nos backups. */
    public function down(): void {}
};
