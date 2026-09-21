<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class CnpjCache extends Model
{
    protected $table = 'cnpj_cache';

    protected $primaryKey = 'cnpj';

    protected $keyType = 'string';

    public $incrementing = false;

    public $timestamps = false;

    protected $fillable = ['cnpj', 'razao_social', 'nome_fantasia', 'cnae', 'cnae_descricao', 'consultado_em'];
}
