<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\Schema;

/**
 * Pedido de justificativa (19/10/2026): o gestor pergunta, o colaborador responde.
 *
 * Estado, sem coluna própria (deriva dos carimbos):
 *   cancelada  → cancelada_em preenchido (o gestor desistiu antes da resposta)
 *   respondida → resposta preenchida
 *   pendente   → o resto
 *
 * Os carimbos e a resposta ficam FORA do fillable: quem decide é o servidor, nunca o corpo
 * da requisição.
 */
class Justificativa extends Model
{
    use HasUuids;

    protected $table = 'justificativas';

    protected $fillable = ['colaborador_id', 'pedido_por', 'motivo', 'mensagem'];

    protected function casts(): array
    {
        return [
            'respondido_em' => 'datetime',
            'visto_em' => 'datetime',
            'cancelada_em' => 'datetime',
            'email_enviado' => 'boolean',
        ];
    }

    /* A tabela existe? (memorizado). Protege o período entre publicar a API nova e a
       migração rodar: o Rastreio e a exclusão de colaborador não podem quebrar por isso. */
    public static function tabelaExiste(): bool
    {
        static $existe = null;
        if ($existe === null) {
            try {
                $existe = Schema::hasTable('justificativas');
            } catch (\Throwable) {
                $existe = false;
            }
        }

        return $existe;
    }

    public function colaborador(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'colaborador_id');
    }

    public function autor(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'pedido_por');
    }

    public function status(): string
    {
        if ($this->cancelada_em) {
            return 'cancelada';
        }

        return $this->resposta !== null ? 'respondida' : 'pendente';
    }

    /** JSON que o app recebe (datas em ISO UTC com fuso, como o resto da API). */
    public function paraApp(): array
    {
        return [
            'id' => $this->id,
            'colaborador_id' => $this->colaborador_id,
            'colaborador_nome' => $this->colaborador?->nome,
            'pedido_por' => $this->pedido_por,
            'pedido_por_nome' => $this->autor?->nome,
            'motivo' => $this->motivo,
            'mensagem' => $this->mensagem,
            'status' => $this->status(),
            'pedido_em' => $this->created_at?->toIso8601String(),
            'resposta' => $this->resposta,
            'respondido_em' => $this->respondido_em?->toIso8601String(),
            'visto_em' => $this->visto_em?->toIso8601String(),
            'cancelada_em' => $this->cancelada_em?->toIso8601String(),
            'cancelada_por' => $this->cancelada_por,
            'email_enviado' => (bool) $this->email_enviado,   // o gestor fica sabendo se o e-mail do pedido não saiu
        ];
    }
}
