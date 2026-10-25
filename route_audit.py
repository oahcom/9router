import sqlite3, json
DB='/home/administrator/.hermes/data/state/workflows.db'
c=sqlite3.connect(f'file:{DB}?mode=ro', uri=True); c.row_factory=sqlite3.Row
TPL={r['template_id']: json.loads(r['steps_json']) for r in c.execute("select template_id, steps_json from workflow_templates")}

def steps_of(tid):
    for k in (tid, 'WF-'+str(tid)):
        if k in TPL:
            return [(s.get('step_id') or s.get('id'), s.get('target_role','')) for s in TPL[k]]
    return []

rows=c.execute("select instance_id, template_id, step_results, status from workflow_instances where step_results like '%rework_ids%'").fetchall()
print('instances with rework_ids:', len(rows))
mis=[]; ok=0
for r in rows:
    try: sr=json.loads(r['step_results'] or '{}')
    except Exception: continue
    st=steps_of(r['template_id'])
    for sid,sd in sr.items():
        if not isinstance(sd,dict): continue
        rids=sd.get('rework_ids') or []
        if not rids: continue
        idx=[i for i,(a,b) in enumerate(st) if a==sid]
        up=st[idx[0]-1][1] if idx and idx[0]>0 else ''
        for rid in rids:
            rw=c.execute("select template_id,status from workflow_instances where instance_id=?",(rid,)).fetchone()
            if not rw: continue
            tpl=(rw['template_id'] or '').replace('WF-','')
            if up=='product_architect' and tpl!='architect_full_design':
                mis.append((r['instance_id'][:14], sid, up, tpl, rw['status']))
            else: ok+=1
print('design-reviewed-but-rework-to-other:', len(mis), ' aligned:', ok)
for d in mis[:20]: print('  ', d)
