-- Schéma Supabase pour la synchronisation multi-appareils.
--
-- À appliquer une fois, dans l'éditeur SQL de la console Supabase, sur un projet neuf —
-- puis renseigner l'URL du projet et sa clé publique dans js/config.js.
--
-- ⚠️ Après application, désactiver l'inscription publique :
--    Authentication → Providers → Email → décocher « Enable sign ups ».
--    La clé publique est embarquée dans le client par conception ; inscription ouverte
--    signifie que quiconque lit le code source peut se créer un compte. Les comptes se
--    créent à la main depuis Authentication → Users.

-- ---------------------------------------------------------------------------
-- Droits commerciaux (marques autorisées, offre)
-- ---------------------------------------------------------------------------
create table if not exists public.entitlements (
    user_id     uuid primary key references auth.users (id) on delete cascade,
    brands      text[] not null default '{toshiba}',
    plan        text   not null default 'trial',
    valid_until date,
    created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Chantiers (configurations de dimensionnement)
-- ---------------------------------------------------------------------------
-- `seq` est le curseur de synchronisation : un entier stric­tement croissant assigné par le
-- SERVEUR à chaque écriture. Il n'utilise jamais l'heure d'un client — un curseur horodaté
-- se casse sur l'ordre de validation des transactions même avec des horloges parfaites
-- (deux transactions peuvent valider dans l'ordre inverse de leurs horodatages).
create sequence if not exists public.configurations_seq;

create table if not exists public.configurations (
    id          uuid primary key,           -- généré côté client : deux appareils hors-ligne
                                            -- ne peuvent structurellement pas collisionner
    owner       uuid not null references auth.users (id) on delete cascade,
    client_name text not null,              -- dénormalisé : pas de table `clients` en v1
    zone        text not null,
    brand       text,
    mode        text,
    result_str  text,
    -- rooms, params, selection, equipments, roomDetails : le serveur n'a aucune raison de
    -- requêter à l'intérieur d'un instantané de dimensionnement, et promouvoir ces champs en
    -- colonnes imposerait une migration SQL à chaque évolution de js/calcul.js.
    body        jsonb not null,
    saved_at    timestamptz not null,
    created_at  timestamptz not null,
    updated_at  timestamptz not null,       -- affirmé par le client : clé du dernier-écrit-gagne
    deleted_at  timestamptz,                -- pierre tombale : la suppression est douce
    seq         bigint not null
);

create index if not exists configurations_owner_seq_idx on public.configurations (owner, seq);
create index if not exists configurations_owner_client_idx on public.configurations (owner, client_name);

-- ---------------------------------------------------------------------------
-- Trigger : propriétaire imposé par le serveur, curseur assigné, horloge bridée
-- ---------------------------------------------------------------------------
-- `search_path` est épinglé explicitement : une fonction `security definer` sans
-- search_path fixe est un vecteur connu d'élévation de privilèges (un appelant peut
-- interposer un schéma contenant ses propres fonctions).
create or replace function public.configurations_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    -- Le propriétaire est imposé ici, jamais accepté du client : écrire dans le compte
    -- d'autrui devient impossible à *formuler*, et la RLS ci-dessous devient un second
    -- rempart plutôt que l'unique.
    new.owner := auth.uid();

    new.seq := nextval('public.configurations_seq');

    -- Bride du futur. Une tablette dont l'horloge affiche 2030 gagnerait sinon TOUS les
    -- conflits, pour toujours, de façon invisible — c'est la panne d'horloge qui mord
    -- réellement en pratique. Le client applique déjà la même bride (js/reconcile.js) ;
    -- celle-ci est la ceinture par-dessus les bretelles, côté serveur où elle ne peut pas
    -- être contournée.
    if new.updated_at > now() + interval '1 day' then
        raise exception 'updated_at trop loin dans le futur (%). Horloge de l''appareil à vérifier.', new.updated_at;
    end if;

    return new;
end;
$$;

drop trigger if exists configurations_before_write_trg on public.configurations;
create trigger configurations_before_write_trg
    before insert or update on public.configurations
    for each row execute function public.configurations_before_write();

-- ---------------------------------------------------------------------------
-- Sécurité au niveau des lignes
-- ---------------------------------------------------------------------------
alter table public.configurations enable row level security;
alter table public.entitlements   enable row level security;

drop policy if exists configurations_select on public.configurations;
drop policy if exists configurations_insert on public.configurations;
drop policy if exists configurations_update on public.configurations;

create policy configurations_select on public.configurations
    for select using (owner = auth.uid());

create policy configurations_insert on public.configurations
    for insert with check (owner = auth.uid());

create policy configurations_update on public.configurations
    for update using (owner = auth.uid()) with check (owner = auth.uid());

-- Volontairement AUCUNE politique `delete` : la suppression est douce (deleted_at), et une
-- suppression dure devient impossible depuis le client. Une pierre tombale doit pouvoir se
-- propager aux autres appareils — un enregistrement réellement effacé ne le pourrait pas.

drop policy if exists entitlements_select on public.entitlements;
create policy entitlements_select on public.entitlements
    for select using (user_id = auth.uid());

-- Volontairement AUCUNE politique d'écriture sur `entitlements` — c'est tout l'intérêt.
-- C'est un droit commercial : si l'utilisateur pouvait modifier sa propre ligne, il
-- s'accorderait Panasonic aujourd'hui et n'importe quelle offre payante demain. Écriture
-- depuis la console uniquement. Les champs réellement éditables par l'utilisateur (raison
-- sociale, logo sur le PDF) iront dans une table `profiles` séparée avec sa propre
-- politique — jamais ici.
