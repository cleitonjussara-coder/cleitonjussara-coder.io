<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\Schema;

/**
 * Aviso para corrigir uma nota (24/10/2026): o gestor/admin avisa o dono da nota; o colaborador corrige.
 *
 * Estado, sem coluna própria: aberto = visto_em vazio. O carimbo fica FORA do fillable: quem decide é o
 * servidor, nunca o corpo da requisição.
 */
class AvisoCorrecao extends Model
{
    use HasUuids;

    protected $table = 'avisos_correcao';

    protected $fillable = ['nota_id', 'colaborador_id', 'pedido_por', 'motivos', 'mensagem', 'nota_titulo', 'nota_data', 'nota_valor'];

    protected function casts(): array
    {
        return [
            'motivos' => 'array',
            'nota_valor' => 'float',
            'visto_em' => 'datetime',
            'agrupado' => 'boolean',
            'email_enviado' => 'boolean',
        ];
    }

    /* A tabela existe? (memorizado por requisição/processo). Protege o período entre publicar a API nova e a
       migração rodar: o sino, o quadro de pendências e a exclusão de colaborador não podem quebrar por isso. */
    private static ?bool $existe = null;

    public static function tabelaExiste(): bool
    {
        if (self::$existe === null) {
            try {
                self::$existe = Schema::hasTable('avisos_correcao');
            } catch (\Throwable) {
                self::$existe = false;
            }
        }

        return self::$existe;
    }

    /** Só para teste: esquece o que foi memorizado. */
    public static function esquecerTabela(): void
    {
        self::$existe = null;
    }

    public function nota(): BelongsTo
    {
        return $this->belongsTo(Nota::class, 'nota_id');
    }

    public function colaborador(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'colaborador_id');
    }

    public function autor(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'pedido_por');
    }

    /** JSON que o app recebe (datas em ISO UTC com fuso, como o resto da API). */
    public function paraApp(): array
    {
        return [
            'id' => $this->id,
            'nota_id' => $this->nota_id,
            'colaborador_id' => $this->colaborador_id,
            'colaborador_nome' => $this->colaborador?->nome,
            'pedido_por' => $this->pedido_por,
            'pedido_por_nome' => $this->autor?->nome,
            'motivos' => $this->motivos ?? [],
            'mensagem' => $this->mensagem,
            'nota_titulo' => $this->nota_titulo,
            'nota_data' => $this->nota_data,
            'nota_valor' => $this->nota_valor,
            'avisado_em' => $this->created_at?->toIso8601String(),
            'visto_em' => $this->visto_em?->toIso8601String(),
            'agrupado' => (bool) $this->agrupado,             // só no sino: o celular e o e-mail já tinham saído há pouco
            'email_enviado' => (bool) $this->email_enviado,   // o gestor fica sabendo se o e-mail não saiu
        ];
    }
}
