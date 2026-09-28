<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Nota extends Model
{
    public const TIPOS = ['RDA', 'RDM'];

    public const SUBTIPOS = ['Abastecimento', 'Hospedagem', 'Outros'];

    /* colaborador CV (21/09/2026): cv = pagou com o cartão corporativo; carteira = do próprio bolso.
       25/09/2026: 'reembolso' virou 'carteira' — Reembolso e Repasse eram o mesmo dinheiro (o que vai
       para a conta do colaborador) com nomes diferentes por regime; unificado como Repasse na tela.
       'empresa' é novo: nota de faturamento que a empresa paga direto, sem passar pelo colaborador. */
    /** Com que dinheiro a despesa foi paga:
     *  cv        → cartão corporativo Alelo, no regime CV (aba CV ALELO)
     *  carteira  → bolso do colaborador, a devolver por repasse (aba CV REEMBOLSO)
     *  empresa   → nota de faturamento paga direto pela empresa; não entra no saldo de ninguém */
    public const PAGAMENTOS = ['cv', 'carteira', 'empresa'];

    /** Único consumidor aceito na nota, além de nenhum (24/09/2026):
     *  o CNPJ da Petermann & Morais. Nota no CPF de terceiro não presta
     *  contas — o app barra no lançamento. */
    public const CNPJ_EMPRESA = '17117768000142';

    /* Documento fiscal: cupom NFC-e, NF-e (XML/PDF), DANFE (NF-e impressa),
       NFS-e (serviço) ou outro comprovante (recibo). */
    public const DOCUMENTOS = ['nfce', 'nfe', 'danfe', 'nfse', 'outro'];

    /** Pasta de anexo para nota de Faturamento sem colaborador (28/09/2026):
     *  user_id pode ser null só nessas notas — mas o caminho do arquivo
     *  (FotoStorage) precisa de um nome de pasta, então usa esta em vez do
     *  user_id de ninguém. Nunca é um id real de colaborador (UUID). */
    public const PASTA_GERAL = 'geral';

    protected $table = 'notas';

    protected $keyType = 'string';

    public $incrementing = false;

    /* Tudo que o app manda no upsert. created_by/updated_by são preenchidos
       pelo controller (auditoria), nunca pelo cliente. */
    protected $fillable = [
        'id', 'user_id', 'tipo', 'subtipo', 'pagamento', 'cnpj', 'consumidor', 'razao_social', 'valor',
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
