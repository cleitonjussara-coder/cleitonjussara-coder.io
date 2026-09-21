<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

class RepasseEmail extends Model
{
    use HasUuids;

    public const UPDATED_AT = null;

    protected $table = 'repasse_emails';

    protected $fillable = ['repasse_id', 'provider_id', 'erro'];
}
