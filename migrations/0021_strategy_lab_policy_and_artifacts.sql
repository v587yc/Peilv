BEGIN;

CREATE OR REPLACE FUNCTION strategy_lab_canonicalize_text(value TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog,public AS $$
  SELECT regexp_replace(regexp_replace(normalize(translate(value, U&'\0009\000D\000A\00A0\202F\3000', '      '), NFC), ' +', ' ', 'g'), '^ +| +$', '', 'g')
$$;

CREATE TABLE strategy_lab_match_facts (
 id UUID PRIMARY KEY, match_id VARCHAR(20) NOT NULL, match_date VARCHAR(8) NOT NULL,
 league_name_raw TEXT NOT NULL, league_name_normalized TEXT NOT NULL, kickoff_at TIMESTAMPTZ NOT NULL,
 source TEXT NOT NULL, source_observed_at TIMESTAMPTZ NOT NULL, dataset_cutoff_at TIMESTAMPTZ NOT NULL,
 canonical_payload JSONB NOT NULL, content_hash TEXT NOT NULL, revision INTEGER NOT NULL,
 supersedes_id UUID REFERENCES strategy_lab_match_facts(id), schema_version INTEGER NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_match_facts_date_check CHECK(match_date~'^[0-9]{8}$' AND to_char(to_date(match_date,'YYYYMMDD'),'YYYYMMDD')=match_date),
 CONSTRAINT strategy_lab_match_facts_canonical_check CHECK(league_name_normalized=strategy_lab_canonicalize_text(league_name_raw) AND league_name_normalized<>''),
 CONSTRAINT strategy_lab_match_facts_time_check CHECK(source_observed_at<=dataset_cutoff_at),
 CONSTRAINT strategy_lab_match_facts_hash_check CHECK(content_hash~'^[0-9a-f]{64}$'),
 CONSTRAINT strategy_lab_match_facts_revision_check CHECK(revision>0 AND schema_version>0),
 UNIQUE(match_id,match_date,source,schema_version,revision), UNIQUE(match_id,match_date,source,schema_version,content_hash)
);
CREATE UNIQUE INDEX strategy_lab_match_facts_supersedes_unique ON strategy_lab_match_facts(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX strategy_lab_match_facts_asof_idx ON strategy_lab_match_facts(match_id,match_date,source_observed_at DESC,revision DESC);

CREATE TABLE strategy_lab_focused_league_baselines (
 id UUID PRIMARY KEY, source TEXT NOT NULL, source_observed_at TIMESTAMPTZ NOT NULL, dataset_cutoff_at TIMESTAMPTZ NOT NULL,
 canonical_payload JSONB NOT NULL, content_hash TEXT NOT NULL UNIQUE, member_count INTEGER NOT NULL,
 is_complete BOOLEAN NOT NULL, completed_at TIMESTAMPTZ, actor TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_focused_baseline_complete_check CHECK(is_complete AND completed_at=source_observed_at),
 CONSTRAINT strategy_lab_focused_baseline_time_check CHECK(source_observed_at<=dataset_cutoff_at),
  CONSTRAINT strategy_lab_focused_baseline_hash_check CHECK(content_hash~'^[0-9a-f]{64}$'), CONSTRAINT strategy_lab_focused_baseline_count_check CHECK(member_count>0)
);

CREATE TABLE strategy_lab_focused_league_events (
 id UUID PRIMARY KEY, baseline_id UUID NOT NULL REFERENCES strategy_lab_focused_league_baselines(id), source TEXT NOT NULL, league_name_raw TEXT NOT NULL, league_name_normalized TEXT NOT NULL,
 action TEXT NOT NULL, source_observed_at TIMESTAMPTZ NOT NULL, dataset_cutoff_at TIMESTAMPTZ NOT NULL,
 canonical_payload JSONB NOT NULL, content_hash TEXT NOT NULL, revision INTEGER NOT NULL, supersedes_id UUID REFERENCES strategy_lab_focused_league_events(id),
 actor TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_focused_event_action_check CHECK(action IN('add','remove')),
 CONSTRAINT strategy_lab_focused_event_canonical_check CHECK(league_name_normalized=strategy_lab_canonicalize_text(league_name_raw) AND league_name_normalized<>''),
 CONSTRAINT strategy_lab_focused_event_time_check CHECK(source_observed_at<=dataset_cutoff_at),
 CONSTRAINT strategy_lab_focused_event_hash_check CHECK(content_hash~'^[0-9a-f]{64}$'),
 CONSTRAINT strategy_lab_focused_event_revision_check CHECK(revision>0),
  UNIQUE(baseline_id,source,league_name_normalized,revision), UNIQUE(content_hash)
);
CREATE UNIQUE INDEX strategy_lab_focused_event_supersedes_unique ON strategy_lab_focused_league_events(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX strategy_lab_focused_event_asof_idx ON strategy_lab_focused_league_events(source_observed_at,revision);

CREATE TABLE strategy_lab_league_policy_artifacts (
 content_hash TEXT PRIMARY KEY, version_hash TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, leagues JSONB NOT NULL,
 canonical_payload JSONB NOT NULL, source_row_count INTEGER NOT NULL, schema_version INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_policy_artifact_mode_check CHECK(mode='user_focused_leagues'),
 CONSTRAINT strategy_lab_policy_artifact_hash_check CHECK(content_hash~'^[0-9a-f]{64}$' AND version_hash=content_hash),
 CONSTRAINT strategy_lab_policy_artifact_count_check CHECK(source_row_count=jsonb_array_length(leagues) AND source_row_count>0 AND schema_version>0)
);
CREATE TABLE strategy_lab_league_policy_captures (
 id UUID PRIMARY KEY, artifact_hash TEXT NOT NULL REFERENCES strategy_lab_league_policy_artifacts(content_hash),
 dataset_cutoff_at TIMESTAMPTZ NOT NULL, captured_at TIMESTAMPTZ NOT NULL, source_history_cutoff TIMESTAMPTZ NOT NULL,
 evidence_hash TEXT NOT NULL, created_by TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_policy_capture_time_check CHECK(source_history_cutoff=dataset_cutoff_at AND dataset_cutoff_at<=captured_at),
 CONSTRAINT strategy_lab_policy_capture_hash_check CHECK(evidence_hash~'^[0-9a-f]{64}$')
);
CREATE INDEX strategy_lab_policy_capture_asof_idx ON strategy_lab_league_policy_captures(artifact_hash,dataset_cutoff_at,captured_at);

CREATE TABLE strategy_lab_strategy_artifacts (
 strategy_id TEXT NOT NULL, version TEXT NOT NULL, artifact_hash TEXT PRIMARY KEY, engine_version TEXT NOT NULL,
 definition JSONB NOT NULL, canonical_payload JSONB NOT NULL, code_compatibility TEXT NOT NULL, schema_version INTEGER NOT NULL,
 behavior_corpus_hash TEXT NOT NULL, executable BOOLEAN NOT NULL, created_by TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_strategy_artifact_id_check CHECK(strategy_id IN('A','B','C','D')),
 CONSTRAINT strategy_lab_strategy_artifact_hash_check CHECK(artifact_hash~'^[0-9a-f]{64}$' AND behavior_corpus_hash~'^[0-9a-f]{64}$'),
 CONSTRAINT strategy_lab_strategy_artifact_definition_check CHECK(jsonb_typeof(definition)='object' AND definition<>'{}'::jsonb AND schema_version>0),
 CONSTRAINT strategy_lab_strategy_d_check CHECK(strategy_id<>'D' OR executable=FALSE), UNIQUE(strategy_id,version)
);

CREATE TABLE strategy_lab_strategy_publications (
 id UUID PRIMARY KEY, root_id UUID NOT NULL, artifact_hash TEXT NOT NULL REFERENCES strategy_lab_strategy_artifacts(artifact_hash), status TEXT NOT NULL,
 effective_from TIMESTAMPTZ NOT NULL, effective_to TIMESTAMPTZ, revision INTEGER NOT NULL, supersedes_id UUID REFERENCES strategy_lab_strategy_publications(id),
 published_at TIMESTAMPTZ NOT NULL, retired_at TIMESTAMPTZ, actor TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_publication_status_check CHECK(status IN('published','retired')),
 CONSTRAINT strategy_lab_publication_interval_check CHECK(effective_to IS NULL OR effective_to>effective_from),
 CONSTRAINT strategy_lab_publication_lifecycle_check CHECK((status='published' AND retired_at IS NULL) OR (status='retired' AND retired_at IS NOT NULL AND effective_to=retired_at)),
 CONSTRAINT strategy_lab_publication_revision_check CHECK(revision>0), UNIQUE(root_id,revision)
);
CREATE UNIQUE INDEX strategy_lab_publication_supersedes_unique ON strategy_lab_strategy_publications(supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TABLE strategy_lab_build_artifacts (
 build_id TEXT PRIMARY KEY, manifest_digest TEXT NOT NULL, commit_sha TEXT NOT NULL, release_id TEXT NOT NULL, artifact_digest TEXT NOT NULL, compatibility TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_build_id_check CHECK(build_id~'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
 CONSTRAINT strategy_lab_build_identity_check CHECK(manifest_digest~'^[0-9a-f]{64}$' AND commit_sha~'^[0-9a-f]{40}$' AND release_id~'^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$' AND artifact_digest~'^[0-9a-f]{64}$')
);

CREATE OR REPLACE FUNCTION strategy_lab_validate_match_fact_insert() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE prior strategy_lab_match_facts%ROWTYPE; BEGIN
 IF NEW.canonical_payload<>jsonb_build_object('schemaVersion',NEW.schema_version,'matchId',NEW.match_id,'matchDate',NEW.match_date,'league',NEW.league_name_normalized,'kickoffAt',NEW.kickoff_at,'source',NEW.source,'sourceObservedAt',NEW.source_observed_at,'datasetCutoffAt',NEW.dataset_cutoff_at,'revision',NEW.revision) THEN RAISE EXCEPTION 'invalid match canonical payload'; END IF;
 IF NEW.revision=1 THEN IF NEW.supersedes_id IS NOT NULL THEN RAISE EXCEPTION 'first revision supersedes'; END IF; ELSE SELECT * INTO prior FROM strategy_lab_match_facts WHERE id=NEW.supersedes_id FOR KEY SHARE; IF NOT FOUND OR prior.match_id<>NEW.match_id OR prior.match_date<>NEW.match_date OR prior.source<>NEW.source OR prior.schema_version<>NEW.schema_version OR prior.revision<>NEW.revision-1 OR NEW.source_observed_at<prior.source_observed_at OR NEW.dataset_cutoff_at<prior.dataset_cutoff_at THEN RAISE EXCEPTION 'invalid match revision chain'; END IF; END IF; RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION strategy_lab_validate_focused_baseline_insert() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE item TEXT; previous BYTEA; current_bytes BYTEA; n INTEGER:=0; BEGIN
 IF jsonb_typeof(NEW.canonical_payload->'leagues')<>'array' OR NEW.canonical_payload<>jsonb_build_object('schemaVersion',1,'baselineId',NEW.id,'source',NEW.source,'sourceObservedAt',NEW.source_observed_at,'leagues',NEW.canonical_payload->'leagues') THEN RAISE EXCEPTION 'invalid baseline canonical payload'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements_text(NEW.canonical_payload->'leagues') AS entry(value) LOOP current_bytes:=convert_to(item,'UTF8'); IF item='' OR item<>public.strategy_lab_canonicalize_text(item) OR (previous IS NOT NULL AND previous>=current_bytes) THEN RAISE EXCEPTION 'noncanonical baseline member'; END IF; previous:=current_bytes;n:=n+1; END LOOP;
 IF n<>NEW.member_count OR n=0 THEN RAISE EXCEPTION 'baseline member count mismatch'; END IF; RETURN NEW; EXCEPTION WHEN data_exception THEN RAISE EXCEPTION 'baseline members must be strings'; END $$;

CREATE OR REPLACE FUNCTION strategy_lab_validate_focused_baseline_complete() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE baseline strategy_lab_focused_league_baselines%ROWTYPE; baseline_key UUID; actual_count INTEGER; BEGIN
 IF TG_TABLE_NAME='strategy_lab_focused_league_baselines' THEN baseline_key:=NEW.id; ELSE baseline_key:=NEW.baseline_id; END IF;
 SELECT * INTO baseline FROM strategy_lab_focused_league_baselines WHERE id=baseline_key; IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT COUNT(*) INTO actual_count FROM strategy_lab_focused_league_events e WHERE e.baseline_id=baseline.id AND e.source=baseline.source AND e.revision=1 AND e.action='add' AND e.source_observed_at=baseline.source_observed_at AND e.dataset_cutoff_at=baseline.dataset_cutoff_at;
 IF actual_count<>baseline.member_count OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(baseline.canonical_payload->'leagues') member WHERE NOT EXISTS(SELECT 1 FROM strategy_lab_focused_league_events e WHERE e.baseline_id=baseline.id AND e.source=baseline.source AND e.league_name_normalized=member AND e.revision=1 AND e.action='add' AND e.source_observed_at=baseline.source_observed_at AND e.dataset_cutoff_at=baseline.dataset_cutoff_at)) THEN RAISE EXCEPTION 'incomplete focused league baseline'; END IF; RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION strategy_lab_validate_focused_event_insert() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE prior strategy_lab_focused_league_events%ROWTYPE; BEGIN
 IF NEW.canonical_payload<>jsonb_build_object('schemaVersion',1,'baselineId',NEW.baseline_id,'source',NEW.source,'league',NEW.league_name_normalized,'action',NEW.action,'sourceObservedAt',NEW.source_observed_at,'datasetCutoffAt',NEW.dataset_cutoff_at,'revision',NEW.revision) THEN RAISE EXCEPTION 'invalid focused event payload'; END IF;
 IF NEW.revision=1 THEN IF NEW.supersedes_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM strategy_lab_focused_league_baselines b WHERE b.id=NEW.baseline_id AND b.source=NEW.source AND b.is_complete AND b.source_observed_at=NEW.source_observed_at AND NEW.action='add') THEN RAISE EXCEPTION 'invalid baseline event'; END IF; ELSE SELECT * INTO prior FROM strategy_lab_focused_league_events WHERE id=NEW.supersedes_id FOR KEY SHARE; IF NOT FOUND OR prior.source<>NEW.source OR prior.league_name_normalized<>NEW.league_name_normalized OR prior.revision<>NEW.revision-1 OR NEW.source_observed_at<prior.source_observed_at OR NEW.dataset_cutoff_at<prior.dataset_cutoff_at THEN RAISE EXCEPTION 'invalid focused event chain'; END IF; END IF; RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION strategy_lab_validate_policy_artifact() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE item TEXT; previous TEXT; n INTEGER:=0; BEGIN
 IF jsonb_typeof(NEW.leagues)<>'array' OR jsonb_array_length(NEW.leagues)=0 THEN RAISE EXCEPTION 'empty policy'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements_text(NEW.leagues) AS entry(value) LOOP IF item<>public.strategy_lab_canonicalize_text(item) OR item='' OR (previous IS NOT NULL AND convert_to(previous,'UTF8')>=convert_to(item,'UTF8')) THEN RAISE EXCEPTION 'noncanonical policy'; END IF; previous:=item;n:=n+1; END LOOP;
 IF NEW.canonical_payload<>jsonb_build_object('schemaVersion',NEW.schema_version,'mode',NEW.mode,'leagues',NEW.leagues) THEN RAISE EXCEPTION 'invalid policy payload'; END IF; RETURN NEW; EXCEPTION WHEN data_exception THEN RAISE EXCEPTION 'policy entries must be strings'; END $$;

CREATE OR REPLACE FUNCTION strategy_lab_validate_strategy_artifact() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW.schema_version<>1 OR NEW.canonical_payload<>jsonb_build_object('schemaVersion',NEW.schema_version,'engineVersion',NEW.engine_version,'codeCompatibility',NEW.code_compatibility,'behaviorCorpusHash',NEW.behavior_corpus_hash,'definition',NEW.definition) OR NEW.definition->>'strategyId'<>NEW.strategy_id OR NEW.definition->>'version'<>NEW.version OR (NEW.definition->>'executable')::BOOLEAN<>NEW.executable THEN RAISE EXCEPTION 'invalid strategy payload'; END IF;
 IF (NEW.strategy_id IN('A','B') AND NEW.definition<>jsonb_build_object('strategyId',NEW.strategy_id,'version',NEW.version,'executable',TRUE,'deterministic',TRUE)) OR (NEW.strategy_id='C' AND NEW.definition<>jsonb_build_object('strategyId','C','version',NEW.version,'executable',TRUE,'fallback','A','completeWithoutExecutor','unavailable')) OR (NEW.strategy_id='D' AND NEW.definition<>jsonb_build_object('strategyId','D','version',NEW.version,'executable',FALSE,'availability','compatibility-only')) THEN RAISE EXCEPTION 'invalid strategy definition'; END IF; RETURN NEW; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid strategy definition'; END $$;

CREATE OR REPLACE FUNCTION strategy_lab_validate_publication_insert() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE prior strategy_lab_strategy_publications%ROWTYPE; sid TEXT; BEGIN
 IF NEW.status='retired' AND (NEW.effective_to IS NULL OR NEW.effective_to<=NEW.effective_from OR NEW.retired_at<>NEW.effective_to) THEN RAISE EXCEPTION 'invalid retirement'; END IF;
 IF NEW.revision=1 THEN IF NEW.supersedes_id IS NOT NULL OR NEW.root_id<>NEW.id THEN RAISE EXCEPTION 'first publication identity'; END IF; ELSE SELECT * INTO prior FROM strategy_lab_strategy_publications WHERE id=NEW.supersedes_id FOR KEY SHARE; IF NOT FOUND OR prior.root_id<>NEW.root_id OR prior.artifact_hash<>NEW.artifact_hash OR prior.revision<>NEW.revision-1 OR NEW.published_at<prior.published_at OR NEW.effective_from<>prior.effective_from THEN RAISE EXCEPTION 'invalid publication chain'; END IF; END IF;
 SELECT strategy_id INTO sid FROM strategy_lab_strategy_artifacts WHERE artifact_hash=NEW.artifact_hash;
 IF EXISTS(SELECT 1 FROM strategy_lab_strategy_publications p JOIN strategy_lab_strategy_artifacts a ON a.artifact_hash=p.artifact_hash WHERE a.strategy_id=sid AND p.root_id<>NEW.root_id AND p.status='published' AND NOT EXISTS(SELECT 1 FROM strategy_lab_strategy_publications newer WHERE newer.root_id=p.root_id AND newer.revision>p.revision) AND tstzrange(p.effective_from,p.effective_to,'[)')&&tstzrange(NEW.effective_from,NEW.effective_to,'[)')) THEN RAISE EXCEPTION 'publication intervals overlap'; END IF; RETURN NEW; END $$;

CREATE TRIGGER strategy_lab_match_validate BEFORE INSERT ON strategy_lab_match_facts FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_match_fact_insert();
CREATE TRIGGER strategy_lab_focused_baseline_validate BEFORE INSERT ON strategy_lab_focused_league_baselines FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_focused_baseline_insert();
CREATE TRIGGER strategy_lab_focused_validate BEFORE INSERT ON strategy_lab_focused_league_events FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_focused_event_insert();
CREATE TRIGGER strategy_lab_policy_validate BEFORE INSERT ON strategy_lab_league_policy_artifacts FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_policy_artifact();
CREATE TRIGGER strategy_lab_artifact_validate BEFORE INSERT ON strategy_lab_strategy_artifacts FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_strategy_artifact();
CREATE TRIGGER strategy_lab_publication_validate BEFORE INSERT ON strategy_lab_strategy_publications FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_publication_insert();
CREATE CONSTRAINT TRIGGER strategy_lab_focused_baseline_complete AFTER INSERT ON strategy_lab_focused_league_baselines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_focused_baseline_complete();
CREATE CONSTRAINT TRIGGER strategy_lab_focused_event_complete AFTER INSERT ON strategy_lab_focused_league_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_focused_baseline_complete();

DO $$
DECLARE
 table_name TEXT;
 role_name TEXT;
BEGIN
 FOREACH table_name IN ARRAY ARRAY[
  'strategy_lab_snapshot_sets','strategy_lab_snapshot_items','strategy_lab_experiment_runs',
  'strategy_lab_predictions','strategy_lab_settlements','strategy_lab_command_receipts',
  'strategy_lab_match_facts','strategy_lab_focused_league_baselines',
  'strategy_lab_focused_league_events','strategy_lab_league_policy_artifacts',
  'strategy_lab_league_policy_captures','strategy_lab_strategy_artifacts',
  'strategy_lab_strategy_publications','strategy_lab_build_artifacts'
 ] LOOP
  IF table_name IN (
   'strategy_lab_match_facts','strategy_lab_focused_league_baselines',
   'strategy_lab_focused_league_events','strategy_lab_league_policy_artifacts',
   'strategy_lab_league_policy_captures','strategy_lab_strategy_artifacts',
   'strategy_lab_strategy_publications','strategy_lab_build_artifacts'
  ) THEN
   EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION strategy_lab_reject_fact_mutation()',table_name,table_name);
  END IF;
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',table_name);
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,role_name);
   END IF;
  END LOOP;
 END LOOP;
END $$;

DO $$
DECLARE
 function_signature TEXT;
 role_name TEXT;
BEGIN
 FOREACH function_signature IN ARRAY ARRAY[
  'strategy_lab_reject_fact_mutation()',
  'strategy_lab_validate_snapshot_item_asof()',
  'strategy_lab_validate_snapshot_item_completeness()',
  'strategy_lab_validate_snapshot_set_insert()',
  'strategy_lab_validate_prediction_snapshot()',
  'strategy_lab_validate_receipt_transition()',
  'strategy_lab_validate_settlement_revision()',
  'strategy_lab_validate_settlement_evidence()',
  'strategy_lab_validate_run_transition()',
  'strategy_lab_validate_run_insert()',
  'strategy_lab_canonicalize_text(text)',
  'strategy_lab_validate_match_fact_insert()',
  'strategy_lab_validate_focused_baseline_insert()',
  'strategy_lab_validate_focused_baseline_complete()',
  'strategy_lab_validate_focused_event_insert()',
  'strategy_lab_validate_policy_artifact()',
  'strategy_lab_validate_strategy_artifact()',
  'strategy_lab_validate_publication_insert()'
 ] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',function_signature);
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',function_signature,role_name);
   END IF;
  END LOOP;
 END LOOP;
END $$;

INSERT INTO schema_migrations(version,description) VALUES('0021_strategy_lab_policy_and_artifacts','Add temporal policy captures, immutable strategy publications and trusted build facts');
COMMIT;
