import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { seedDatabase } from './seed.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  role_label TEXT NOT NULL,
  org TEXT NOT NULL,
  expertise TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  level TEXT NOT NULL,
  parent_id TEXT,
  FOREIGN KEY (parent_id) REFERENCES regions(id)
);

CREATE TABLE IF NOT EXISTS facilities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  address TEXT NOT NULL,
  street_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  manager TEXT NOT NULL,
  built_year INTEGER,
  structure TEXT,
  longitude REAL,
  latitude REAL,
  risk_grade TEXT NOT NULL DEFAULT 'I',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (street_id) REFERENCES regions(id),
  FOREIGN KEY (community_id) REFERENCES regions(id)
);

CREATE TABLE IF NOT EXISTS buildings (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL,
  name TEXT NOT NULL,
  floors INTEGER,
  height REAL,
  area REAL,
  structure TEXT,
  wall_material TEXT,
  roof_type TEXT,
  built_year INTEGER,
  FOREIGN KEY (facility_id) REFERENCES facilities(id)
);

CREATE TABLE IF NOT EXISTS components (
  id TEXT PRIMARY KEY,
  building_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  importance TEXT NOT NULL,
  location TEXT,
  FOREIGN KEY (building_id) REFERENCES buildings(id)
);

CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY,
  task_no TEXT NOT NULL UNIQUE,
  facility_id TEXT NOT NULL,
  building_id TEXT NOT NULL,
  component_id TEXT,
  scope TEXT NOT NULL,
  sensors TEXT NOT NULL,
  planned_at TEXT NOT NULL,
  assignee TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  external_task_no TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (facility_id) REFERENCES facilities(id),
  FOREIGN KEY (building_id) REFERENCES buildings(id),
  FOREIGN KEY (component_id) REFERENCES components(id)
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL,
  type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT,
  size INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (inspection_id) REFERENCES inspections(id)
);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL,
  status TEXT NOT NULL,
  model_version TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  FOREIGN KEY (inspection_id) REFERENCES inspections(id)
);

CREATE TABLE IF NOT EXISTS detections (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  building_id TEXT NOT NULL,
  component_id TEXT,
  type TEXT NOT NULL,
  subtype TEXT NOT NULL,
  confidence REAL NOT NULL,
  bbox TEXT NOT NULL,
  geometry TEXT NOT NULL,
  model_version TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT '待复核',
  created_at TEXT NOT NULL,
  FOREIGN KEY (analysis_id) REFERENCES analyses(id),
  FOREIGN KEY (facility_id) REFERENCES facilities(id),
  FOREIGN KEY (building_id) REFERENCES buildings(id),
  FOREIGN KEY (component_id) REFERENCES components(id)
);

CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  detection_id TEXT NOT NULL UNIQUE,
  defect_type TEXT NOT NULL,
  dimensions TEXT NOT NULL,
  total_score REAL NOT NULL,
  ai_grade TEXT NOT NULL,
  expert_grade TEXT,
  status TEXT NOT NULL DEFAULT '待复核',
  rule_version TEXT NOT NULL,
  reasons TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  disclaimer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (detection_id) REFERENCES detections(id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL UNIQUE,
  detection_id TEXT NOT NULL,
  expert_id TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  opinion TEXT,
  expert_grade TEXT,
  due_at TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  accepted_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (assessment_id) REFERENCES assessments(id),
  FOREIGN KEY (detection_id) REFERENCES detections(id),
  FOREIGN KEY (expert_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL UNIQUE,
  grade TEXT NOT NULL,
  department TEXT NOT NULL,
  owner TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  responded_at TEXT,
  action TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (assessment_id) REFERENCES assessments(id)
);

CREATE TABLE IF NOT EXISTS workorders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  assessment_id TEXT NOT NULL,
  detection_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  building_id TEXT NOT NULL,
  component_id TEXT,
  grade TEXT NOT NULL,
  unit TEXT NOT NULL,
  owner TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,
  requirement TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (assessment_id) REFERENCES assessments(id),
  FOREIGN KEY (detection_id) REFERENCES detections(id),
  FOREIGN KEY (facility_id) REFERENCES facilities(id),
  FOREIGN KEY (building_id) REFERENCES buildings(id),
  FOREIGN KEY (component_id) REFERENCES components(id)
);

CREATE TABLE IF NOT EXISTS workorder_events (
  id TEXT PRIMARY KEY,
  workorder_id TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  operator TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workorder_id) REFERENCES workorders(id)
);

CREATE TABLE IF NOT EXISTS acceptances (
  id TEXT PRIMARY KEY,
  workorder_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  result TEXT NOT NULL,
  opinion TEXT NOT NULL,
  before_photo TEXT,
  after_photo TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workorder_id) REFERENCES workorders(id)
);

CREATE TABLE IF NOT EXISTS public_reports (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  contact TEXT,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT NOT NULL,
  community_id TEXT,
  building_id TEXT,
  photo_data TEXT,
  photo_path TEXT,
  quality_score REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '待筛查',
  feedback TEXT NOT NULL DEFAULT '已提交，系统正在进行本地快速筛查。',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (community_id) REFERENCES regions(id),
  FOREIGN KEY (building_id) REFERENCES buildings(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_facilities_region ON facilities(street_id, community_id);
CREATE INDEX IF NOT EXISTS idx_buildings_facility ON buildings(facility_id);
CREATE INDEX IF NOT EXISTS idx_inspections_facility ON inspections(facility_id, status);
CREATE INDEX IF NOT EXISTS idx_detections_review ON detections(review_status);
CREATE INDEX IF NOT EXISTS idx_detections_facility ON detections(facility_id);
CREATE INDEX IF NOT EXISTS idx_detections_analysis ON detections(analysis_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, due_at);
CREATE INDEX IF NOT EXISTS idx_reviews_assessment ON reviews(assessment_id);
CREATE INDEX IF NOT EXISTS idx_workorders_status ON workorders(status, due_at);
CREATE INDEX IF NOT EXISTS idx_workorders_assessment ON workorders(assessment_id);
CREATE INDEX IF NOT EXISTS idx_workorder_events_order ON workorder_events(workorder_id, created_at);
CREATE INDEX IF NOT EXISTS idx_media_inspection ON media(inspection_id);
CREATE INDEX IF NOT EXISTS idx_analyses_inspection ON analyses(inspection_id);
CREATE INDEX IF NOT EXISTS idx_inspections_updated ON inspections(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_public_code ON public_reports(code);
CREATE INDEX IF NOT EXISTS idx_public_community ON public_reports(community_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`;

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function openDatabase({ filename = ':memory:', seed = true } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout = 2000');
  db.exec(SCHEMA);
  const reportColumns = new Set(db.prepare('PRAGMA table_info(public_reports)').all().map((row) => row.name));
  if (!reportColumns.has('photo_path')) {
    db.exec('ALTER TABLE public_reports ADD COLUMN photo_path TEXT');
  }
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (seed && count === 0) seedDatabase(db);
  return db;
}
