// Shared by the statistics panel, item lists and exports.
export function buildTriageStatsRowsSql(period = {}) {
  return `
        with latest_triage_transfers as materialized (
          select distinct on (triage_item_id)
            triage_item_id, id, deposito_destino, status
          from transfer_lots
          where user_id = $1 and source = 'triage'
          order by triage_item_id, created_at desc
        ), matched_triage as (
        select
          t.id,
          t.code,
          t.created_by_user_id,
          t.operator_user_id,
          t.sku,
          t.ean,
          t.serial,
          t.grade_avaliada,
          t.descricao,
          t.status,
          t.destination,
          t.diagnosis_condition,
          t.diagnosis,
          ${period.includePhotos ? "t.diagnosis_photo," : ""}
          t.created_at,
          t.updated_at,
          t.diagnosed_at,
          coalesce(nullif(p.valor_unit, 0), nullif(t.valor_unit, 0), nullif(previous_triage.valor_unit, 0), 0) as valor_unit,
          coalesce(nullif(p.preco_custo, 0), nullif(t.preco_custo, 0), 0) as preco_custo,
          p.id as product__id,
          p.checked_qty as product__checked_qty,
          p.lot_id as product__lot_id,
          p.codigo_ml as product__codigo_ml,
          p.sku as product__sku,
          p.descricao as product__descricao,
          p.ean as product__ean,
          p.valor_unit as product__valor_unit,
          p.preco_custo as product__preco_custo,
          p.qtd_total as product__qtd_total,
          p.created_at as product__created_at,
          l.id as lot__id,
          l.user_id as lot__user_id,
          l.nome_arquivo as lot__nome_arquivo,
          l.percentual_arremate as lot__percentual_arremate,
          l.custo_medio_unitario as lot__custo_medio_unitario,
          l.tipo_custo as lot__tipo_custo,
          l.percentual_custo as lot__percentual_custo,
          l.fornecedor as lot__fornecedor,
          l.prefixo_sku as lot__prefixo_sku,
          l.proximo_sequencial_sku as lot__proximo_sequencial_sku,
          l.no_sheet_suggestions as lot__no_sheet_suggestions,
          l.created_at as lot__created_at,
          (triage_transfer.id is not null) as triage_transferred,
          triage_transfer.deposito_destino as triage_transfer_deposito_destino,
          triage_transfer.status as triage_transfer_status,
          u.id as user__id,
          u.tenant_id as user__tenant_id,
          u.tenant_name as user__tenant_name,
          u.parent_user_id as user__parent_user_id,
          u.role as user__role,
          u.operator_code as user__operator_code,
          u.triage_access as user__triage_access,
          u.transfer_access as user__transfer_access,
          u.stock_transfer_acceptance_access as user__stock_transfer_acceptance_access,
          u.operator_stats_access as user__operator_stats_access,
          u.large_qr_label_access as user__large_qr_label_access,
          u.view_sale_price_access as user__view_sale_price_access,
          u.view_cost_price_access as user__view_cost_price_access,
          u.name as user__name,
          u.email as user__email,
          u.password_hash as user__password_hash,
          u.created_at as user__created_at,
          case
            when p.id is null then null
            else row_number() over (partition by p.id order by t.created_at asc, t.id asc)
          end as product_match_rank
        from triage_items t
        left join lateral (
          select
            pr.*,
            coalesce(sum(ri.qtd_conferida), 0)::int as checked_qty
          from products pr
          join lots l on l.id = pr.lot_id
          left join rz_items ri on ri.product_id = pr.id and ri.lot_id = pr.lot_id
          where l.user_id = t.user_id
            and (cardinality($4::text[]) = 0 or l.id = any($4::text[]))
            and (
              upper(trim(pr.sku)) = upper(trim(nullif(t.sku, '')))
              or upper(trim(pr.codigo_ml)) = upper(trim(nullif(t.product_code, '')))
              or upper(trim(pr.codigo_ml)) = upper(trim(nullif(t.codigo_bling2, '')))
              or upper(trim(pr.codigo_ml)) = upper(trim(nullif(t.asin, '')))
            )
          group by pr.id
          order by pr.created_at desc
          limit 1
        ) p on true
        left join lateral (
          select previous.valor_unit
          from triage_items previous
          where coalesce(nullif(p.valor_unit, 0), nullif(t.valor_unit, 0)) is null
            and previous.user_id = t.user_id
            and previous.id <> t.id
            and previous.valor_unit > 0
            and (
              upper(trim(previous.sku)) = upper(trim(nullif(t.sku, '')))
              or upper(trim(previous.product_code)) = upper(trim(nullif(t.product_code, '')))
              or upper(trim(previous.codigo_bling2)) = upper(trim(nullif(t.codigo_bling2, '')))
              or upper(trim(previous.asin)) = upper(trim(nullif(t.asin, '')))
            )
          order by previous.created_at desc
          limit 1
        ) previous_triage on true
        left join latest_triage_transfers triage_transfer on triage_transfer.triage_item_id = t.id
        left join lots l on l.id = p.lot_id
        left join users u on u.id = coalesce(t.operator_user_id, t.created_by_user_id, t.user_id)
        where t.user_id = $1
          and ($2::timestamptz is null or t.created_at >= $2::timestamptz)
          and ($3::timestamptz is null or t.created_at <= $3::timestamptz)
        )
        select *
        from matched_triage
        where (cardinality($4::text[]) = 0 or (product__id is not null and product_match_rank <= product__checked_qty))
        order by updated_at desc
      `;
}
