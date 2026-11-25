import { evaluateHealth, gradeRank } from './domain.js';

function insert(db, table, row) {
  const entries = Object.entries(row);
  const columns = entries.map(([key]) => key).join(', ');
  const placeholders = entries.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`).run(...entries.map(([, value]) => value));
}

function json(value) {
  return JSON.stringify(value);
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

export function seedDatabase(db) {
  db.exec('BEGIN');
  try {
    const users = [
      ['gov-1', '陈监管', 'government', '区级住建/监管人员', '杭州市某区住房和城乡建设局'],
      ['street-1', '周街道', 'street', '街道管理人员', '试点街道'],
      ['community-1', '吴社区', 'community', '社区管理人员', '桂花苑社区'],
      ['pilot-1', '林巡检', 'pilot', '无人机巡检人员', '轻量化体检作业组'],
      ['expert-1', '赵工', 'expert', '建筑结构专家', '市建筑科学研究院'],
      ['expert-2', '孙工', 'expert', '屋面防水专家', '市建筑科学研究院'],
      ['property-1', '钱物业', 'property', '物业管理人员', '桂花苑物业服务中心'],
      ['repair-1', '李维修', 'repair', '维修施工单位', '城维工程有限公司'],
      ['accept-1', '何验收', 'acceptance', '复检验收人员', '区级房屋安全巡查组'],
      ['admin-1', '系统管理员', 'admin', '系统管理员', '平台运维中心']
    ];
    for (const [id, name, role, roleLabel, org] of users) {
      insert(db, 'users', {
        id,
        name,
        role,
        role_label: roleLabel,
        org,
        expertise: json(role === 'expert' ? ['建筑结构', '建筑材料'] : [])
      });
    }

    const regions = [
      ['region-demo', '杭州市某区（演示）', 'district', null],
      ['street-1', '试点街道', 'street', 'region-demo'],
      ['street-2', '滨水街道（演示）', 'street', 'region-demo'],
      ['community-1', '桂花苑社区', 'community', 'street-1'],
      ['community-2', '文晖社区', 'community', 'street-1'],
      ['community-3', '运河社区', 'community', 'street-2']
    ];
    for (const region of regions) {
      insert(db, 'regions', { id: region[0], name: region[1], level: region[2], parent_id: region[3] });
    }

    const facilities = [
      ['fac-1', '桂花苑小区', '老旧住宅小区', '杭州市某区试点路18号', 'street-1', 'community-1', '桂花苑物业服务中心', 1998, '砖混结构', 120.12, 30.26],
      ['fac-2', '文晖公寓', '老旧住宅小区', '杭州市某区文晖路66号', 'street-1', 'community-2', '文晖公寓物业', 2003, '框架结构', 120.15, 30.29],
      ['fac-3', '运河人家', '老旧住宅小区', '杭州市某区运河东路8号', 'street-2', 'community-3', '运河人家业委会', 2006, '框架结构', 120.18, 30.24],
      ['fac-4', '临河新村', '老旧住宅小区', '杭州市某区临河街27号', 'street-2', 'community-3', '临河新村物业', 1995, '砖混结构', 120.20, 30.27],
      ['fac-5', '云栖公馆', '住宅楼', '杭州市某区云栖路102号', 'street-1', 'community-1', '云栖公馆物业', 2012, '剪力墙结构', 120.10, 30.31],
      ['fac-6', '湖畔家园', '住宅楼', '杭州市某区湖滨街9号', 'street-2', 'community-3', '湖畔家园物业', 2009, '框架结构', 120.22, 30.22]
    ];
    for (const f of facilities) {
      insert(db, 'facilities', {
        id: f[0], name: f[1], category: f[2], address: f[3], street_id: f[4], community_id: f[5],
        manager: f[6], built_year: f[7], structure: f[8], longitude: f[9], latitude: f[10],
        risk_grade: 'I', created_at: hoursAgo(24 * 90), updated_at: hoursAgo(24)
      });
    }

    const buildingNames = ['1幢', '2幢', '3幢'];
    const buildingIds = [];
    for (let f = 0; f < facilities.length; f += 1) {
      for (let b = 0; b < 2; b += 1) {
        const id = `bld-${f + 1}-${b + 1}`;
        buildingIds.push(id);
        insert(db, 'buildings', {
          id,
          facility_id: facilities[f][0],
          name: buildingNames[b],
          floors: 6 + f + b,
          height: (6 + f + b) * 3,
          area: 3200 + f * 280 + b * 150,
          structure: facilities[f][8],
          wall_material: f % 2 ? '真石漆饰面' : '涂料饰面',
          roof_type: b % 2 ? '平屋面' : '坡屋面',
          built_year: facilities[f][7]
        });
        insert(db, 'components', {
          id: `cmp-${f + 1}-${b + 1}-facade`,
          building_id: id,
          name: '南立面外墙饰面',
          type: '外墙饰面',
          importance: f === 0 ? 'high' : 'medium',
          location: '南立面 · 4—6层'
        });
        insert(db, 'components', {
          id: `cmp-${f + 1}-${b + 1}-roof`,
          building_id: id,
          name: '屋面及天沟',
          type: '屋面',
          importance: 'medium',
          location: '屋面东侧排水区'
        });
      }
    }

    const statuses = ['已完成', '已完成', '已完成', '已完成', '已完成', '已完成'];
    const defectTypes = ['crack', 'hollow', 'spall', 'leak', 'corrosion', 'sealant'];
    const severities = [46, 78, 91, 55, 38, 24];
    const importances = ['high', 'high', 'structural', 'medium', 'medium', 'low'];
    const environments = [42, 68, 75, 64, 35, 20];
    const componentKinds = ['facade', 'facade', 'facade', 'roof', 'facade', 'facade'];
    const assessments = [];

    for (let i = 0; i < facilities.length; i += 1) {
      const inspectionId = `insp-${i + 1}`;
      const buildingId = buildingIds[i * 2];
      const componentId = `cmp-${i + 1}-1-${componentKinds[i]}`;
      const createdAt = hoursAgo(12 + i * 19);
      insert(db, 'inspections', {
        id: inspectionId,
        task_no: `XJ-2026-${String(i + 1).padStart(4, '0')}`,
        facility_id: facilities[i][0],
        building_id: buildingId,
        component_id: componentId,
        scope: componentKinds[i] === 'roof' ? '屋顶主要区域、排水口及天沟' : '南立面外墙、外立面及凸出构件根部',
        sensors: json(componentKinds[i] === 'roof' ? ['可见光', '红外'] : ['可见光', '红外']),
        planned_at: hoursAgo(24 + i * 18),
        assignee: '林巡检',
        status: statuses[i],
        progress: statuses[i] === '已完成' ? 100 : statuses[i] === '分析中' ? 72 : statuses[i] === '待分析' ? 50 : statuses[i] === '采集中' ? 25 : 5,
        external_task_no: `UAV-${260100 + i}`,
        created_at: createdAt,
        updated_at: hoursAgo(3 + i * 4)
      });
      insert(db, 'media', {
        id: `media-${i + 1}`,
        inspection_id: inspectionId,
        type: 'visible',
        file_name: `${facilities[i][1]}_${buildingNames[0]}_南立面.jpg`,
        mime_type: 'image/jpeg',
        path: '/assets/facade-day.svg',
        sha256: `demo-sha256-${i + 1}`,
        size: 2_400_000 + i * 180_000,
        metadata: json({ width: 4000, height: 3000, gps: [facilities[i][9], facilities[i][10]], capturedAt: createdAt }),
        created_at: createdAt
      });
      if (statuses[i] === '已完成' || statuses[i] === '分析中') {
        const analysisId = `analysis-${i + 1}`;
        insert(db, 'analyses', {
          id: analysisId,
          inspection_id: inspectionId,
          status: '成功',
          model_version: 'demo-vision-0.1',
          dataset_version: 'demo-dataset-0.1',
          started_at: hoursAgo(10 + i * 18),
          completed_at: hoursAgo(9 + i * 18)
        });
        const detectionId = `det-${i + 1}`;
        insert(db, 'detections', {
          id: detectionId,
          analysis_id: analysisId,
          facility_id: facilities[i][0],
          building_id: buildingId,
          component_id: componentId,
          type: defectTypes[i],
          subtype: defectTypes[i] === 'crack' ? '非结构性裂缝疑似' : '表观异常疑似',
          confidence: Number((0.72 + i * 0.035).toFixed(2)),
          bbox: json({ x: 128 + i * 8, y: 92, width: 260, height: 180 }),
          geometry: json({ length: 186 + i * 22, width: 1.2 + i * 0.4, area: 620 + i * 180, unit: 'px', severity: severities[i], calibrated: false }),
          model_version: 'demo-vision-0.1',
          review_status: i === 0 ? '已确认' : '待复核',
          created_at: hoursAgo(9 + i * 18)
        });
        const evaluation = evaluateHealth({
          defectType: defectTypes[i],
          severity: severities[i],
          componentImportance: importances[i],
          environment: environments[i]
        });
        const assessmentId = `assessment-${i + 1}`;
        insert(db, 'assessments', {
          id: assessmentId,
          detection_id: detectionId,
          defect_type: defectTypes[i],
          dimensions: json(evaluation.dimensions),
          total_score: evaluation.totalScore,
          ai_grade: evaluation.aiGrade,
          expert_grade: i === 1 ? 'III' : null,
          status: i === 1 ? '已复核' : evaluation.aiGrade === 'I' || evaluation.aiGrade === 'II' ? '规则初判' : '待复核',
          rule_version: evaluation.ruleVersion,
          reasons: json(evaluation.reasons),
          recommendation: evaluation.recommendation,
          disclaimer: evaluation.disclaimer,
          created_at: hoursAgo(8 + i * 18),
          updated_at: hoursAgo(2)
        });
        assessments.push({ id: assessmentId, detectionId, evaluation, index: i });

        if (gradeRank(evaluation.aiGrade) >= 3 || i === 1) {
          const reviewId = `review-${i + 1}`;
          const reviewStatus = i === 1 ? '已完成' : i === 2 ? '复核中' : '待接单';
          insert(db, 'reviews', {
            id: reviewId,
            assessment_id: assessmentId,
            detection_id: detectionId,
            expert_id: i === 3 ? 'expert-2' : 'expert-1',
            status: reviewStatus,
            conclusion: i === 1 ? '确认' : null,
            opinion: i === 1 ? '现场资料与AI初判一致，建议按Ⅲ级处置并安排专业检测。' : null,
            expert_grade: i === 1 ? 'III' : null,
            due_at: hoursFromNow(24),
            assigned_at: hoursAgo(7 + i * 18),
            accepted_at: i === 1 || i === 2 ? hoursAgo(6 + i * 18) : null,
            completed_at: i === 1 ? hoursAgo(5) : null
          });
          const responseId = `response-${i + 1}`;
          const responded = i === 1;
          insert(db, 'responses', {
            id: responseId,
            assessment_id: assessmentId,
            grade: evaluation.aiGrade,
            department: '试点街道城市建设办公室',
            owner: i === 1 ? '周街道' : '待分派',
            due_at: hoursFromNow(i === 2 ? 4 : 48),
            status: responded ? '处置中' : '待响应',
            received_at: hoursAgo(i === 1 ? 5 : 2),
            responded_at: responded ? hoursAgo(3) : null,
            action: responded ? '已接收预警并安排现场专业检测。' : null,
            created_at: hoursAgo(i === 1 ? 5 : 2),
            updated_at: hoursAgo(responded ? 3 : 2)
          });
        }
      }
    }

    const extraStatuses = ['待执行', '采集中', '待分析'];
    extraStatuses.forEach((status, index) => {
      const inspectionId = `insp-extra-${index + 1}`;
      const timestamp = hoursAgo(6 + index * 5);
      insert(db, 'inspections', {
        id: inspectionId,
        task_no: `XJ-2026-90${String(index + 1).padStart(2, '0')}`,
        facility_id: facilities[index][0],
        building_id: buildingIds[index * 2 + 1],
        component_id: `cmp-${index + 1}-2-roof`,
        scope: '补充巡检：屋顶及南立面重点区域',
        sensors: json(['可见光']),
        planned_at: hoursFromNow(24 + index * 12),
        assignee: '林巡检',
        status,
        progress: status === '采集中' ? 25 : status === '待分析' ? 65 : 5,
        external_task_no: `UAV-260200-${index + 1}`,
        created_at: timestamp,
        updated_at: timestamp
      });
    });

    const workorders = [
      {
        id: 'wo-1', assessmentId: 'assessment-2', detectionId: 'det-2', facilityId: 'fac-2', buildingId: 'bld-2-1', componentId: 'cmp-2-1-facade',
        grade: 'III', unit: '城维工程有限公司', owner: '李维修', status: '待派单', dueAt: hoursFromNow(72), createdAt: hoursAgo(4), updatedAt: hoursAgo(4), requirement: '对空鼓疑似区域开展现场检测，按专业意见完成加固或修复。'
      },
      {
        id: 'wo-2', assessmentId: 'assessment-3', detectionId: 'det-3', facilityId: 'fac-3', buildingId: 'bld-3-1', componentId: 'cmp-3-1-facade',
        grade: 'IV', unit: '城维工程有限公司', owner: '李维修', status: '处理中', dueAt: hoursFromNow(12), createdAt: hoursAgo(20), updatedAt: hoursAgo(1), requirement: '先落实临时管控，再进行混凝土剥落和露筋专业处置。'
      },
      {
        id: 'wo-3', assessmentId: 'assessment-1', detectionId: 'det-1', facilityId: 'fac-1', buildingId: 'bld-1-1', componentId: 'cmp-1-1-facade',
        grade: 'II', unit: '桂花苑物业服务中心', owner: '钱物业', status: '已销号', dueAt: hoursAgo(8), createdAt: hoursAgo(72), updatedAt: hoursAgo(10), requirement: '复核墙体裂缝变化，完成表面封闭和观察记录。'
      },
      {
        id: 'wo-4', assessmentId: 'assessment-4', detectionId: 'det-4', facilityId: 'fac-4', buildingId: 'bld-4-1', componentId: 'cmp-4-1-roof',
        grade: 'II', unit: '城维工程有限公司', owner: '李维修', status: '整改不通过', dueAt: hoursFromNow(24), createdAt: hoursAgo(48), updatedAt: hoursAgo(6), requirement: '排查屋面渗漏路径，完成防水层修复并提供闭水试验记录。'
      }
    ];
    for (let i = 0; i < workorders.length; i += 1) {
      const order = workorders[i];
      insert(db, 'workorders', {
        id: order.id,
        order_no: `GD-2026-${String(i + 1).padStart(4, '0')}`,
        assessment_id: order.assessmentId,
        detection_id: order.detectionId,
        facility_id: order.facilityId,
        building_id: order.buildingId,
        component_id: order.componentId,
        grade: order.grade,
        unit: order.unit,
        owner: order.owner,
        due_at: order.dueAt,
        status: order.status,
        requirement: order.requirement,
        created_at: order.createdAt,
        updated_at: order.updatedAt
      });
      const eventFlow = order.status === '已销号'
        ? ['待派单', '待接单', '处理中', '待复检', '已销号']
        : order.status === '整改不通过'
          ? ['待派单', '待接单', '处理中', '待复检', '整改不通过']
          : order.status === '处理中'
            ? ['待派单', '待接单', '处理中']
            : ['待派单'];
      eventFlow.forEach((status, index) => {
        insert(db, 'workorder_events', {
          id: `${order.id}-event-${index}`,
          workorder_id: order.id,
          status,
          note: index === eventFlow.length - 1 ? '当前状态' : '流程节点',
          operator: index % 2 ? '李维修' : '周街道',
          created_at: new Date(new Date(order.createdAt).getTime() + index * 3_600_000).toISOString()
        });
      });
    }
    insert(db, 'acceptances', {
      id: 'acceptance-1', workorder_id: 'wo-3', reviewer: '何验收', result: '通过',
      opinion: '维修前后影像对应，裂缝表面封闭完整，纳入下一周期观察。', before_photo: null, after_photo: null,
      created_at: hoursAgo(10)
    });
    insert(db, 'acceptances', {
      id: 'acceptance-2', workorder_id: 'wo-4', reviewer: '何验收', result: '不通过',
      opinion: '渗漏痕迹仍有反复，需补充排水口清理和防水层细节资料。', before_photo: null, after_photo: null,
      created_at: hoursAgo(6)
    });

    const publicReports = [
      ['PUB-202611-0001', 'crack', '六层外墙发现一条斜向细缝，昨晚下雨后看起来更明显。', '桂花苑社区1幢南侧', 'community-1', 'bld-1-1', '待专家复核', '已完成快速筛查，等待专家复核。', 0.91, 0.86],
      ['PUB-202611-0002', 'hollow', '二楼空调外机旁有墙面鼓包，担心脱落。', '文晖社区2幢东侧', 'community-2', 'bld-2-1', '补充材料', '请补充一张包含整面墙体的照片，并保持安全距离。', 0.62, 0.58],
      ['PUB-202611-0003', 'leak', '顶楼楼道顶部有水渍。', '运河社区1幢屋面', 'community-3', 'bld-3-1', '已确认', '线索已确认并转入处置流程。', 0.88, 0.82],
      ['PUB-202611-0004', 'other', '上传了一张道路照片。', '运河社区门口', 'community-3', null, '未采纳', '照片与建筑隐患无关，已归档。', 0.34, 0.12],
      ['PUB-202611-0005', 'corrosion', '地下车库入口附近金属栏杆有锈蚀。', '湖畔家园车库入口', 'community-3', 'bld-6-1', '待筛查', '已提交，系统正在进行本地快速筛查。', 0.8, 0.74]
    ];
    publicReports.forEach((report, index) => {
      insert(db, 'public_reports', {
        id: `public-${index + 1}`,
        code: report[0],
        contact: null,
        type: report[1],
        description: report[2],
        location: report[3],
        community_id: report[4],
        building_id: report[5],
        photo_data: null,
        quality_score: report[8],
        confidence: report[9],
        status: report[6],
        feedback: report[7],
        created_at: hoursAgo(2 + index * 8),
        updated_at: hoursAgo(1 + index * 5)
      });
    });

    const auditSeeds = [
      ['expert-1', '提交专家复核', 'assessment', 'assessment-2', '确认Ⅲ级处置建议'],
      ['gov-1', '启动政府响应', 'response', 'response-2', '责任部门确认接收'],
      ['accept-1', '复检不通过', 'workorder', 'wo-4', '要求补充排水和防水资料'],
      ['pilot-1', '完成AI初判', 'analysis', 'analysis-1', '演示模型输出已留痕']
    ];
    auditSeeds.forEach((row, index) => {
      insert(db, 'audit_logs', {
        id: `audit-${index + 1}`, user_id: row[0], action: row[1], object_type: row[2], object_id: row[3],
        before_json: null, after_json: null, summary: row[4], created_at: hoursAgo(index * 3 + 1)
      });
    });

    const grades = db.prepare('SELECT d.facility_id, a.ai_grade FROM detections d JOIN assessments a ON a.detection_id = d.id').all();
    const highestGrade = new Map();
    for (const item of grades) {
      const current = highestGrade.get(item.facility_id);
      if (!current || gradeRank(item.ai_grade) > gradeRank(current)) highestGrade.set(item.facility_id, item.ai_grade);
    }
    for (const [facilityId, grade] of highestGrade) {
      db.prepare('UPDATE facilities SET risk_grade = ?, updated_at = ? WHERE id = ?').run(grade, hoursAgo(1), facilityId);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
