<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Feriado extends Model
{
    protected $table = 'feriados';

    protected $primaryKey = 'data';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['data', 'nome'];
}
