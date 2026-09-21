<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Nota extends Model
{
    public const TIPOS = ['RDA', 'RDM'];

    public const SUBTIPOS = ['Abastecimento', 'Hospedagem', 'Outros'];

    /* Documento fiscal: cupom NFC-e, NF-e (XML/PDF), DANFE (NF-e impressa),
       NFS-e (serviço) ou outro comprovante (recibo). */
    public const DOCUMENTOS = ['nfce', 'nfe', 'danfe', 'nfse', 'outro'];

    protected $table = 'notas';

    protected $keyType = 'string';

    public $incrementing = false;

    /* Tudo que o app manda no upsert. created_by/updated_by são preenchidos
       pelo controller (auditoria), nunca pelo cliente. */
    protected $fillable = [
        'id', 'user_id', 'tipo', 'subtipo', 'cnpj', 'razao_social', 'valor',
        'data', 'mes', 'ano', 'metodo_captura', 'chave_nfce', 'uf', 'modelo', 'documento', 'numero', 'serie',
        'foto_path', 'qr_url', 'observacao', 'deleted', 'created_at',
    ];

    protected function casts(): array
    {
        return [
            'valor' => 'float',       // JSON numérico, como o PostgREST devolvia (o app soma direto)
            'data' => 'date:Y-m-d',
            'mes' => 'integer',
            'ano' => 'integer',
            'deleted' => 'boolean',
        ];
    }

    public function dono(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'user_id');
    }

    /* Recorte da policy notas_sel: dono vê as suas; gestor/admin veem tudo. */
    public function scopeVisiveisPara(Builder $q, Colaborador $u): Builder
    {
        return $u->veTudo() ? $q : $q->where('user_id', $u->id);
    }
}
