// Molang → JavaScript compiler.
//
// Model scripts use Molang syntax that is not valid JavaScript: `;` statement
// lists with `return`, the binary conditional `a ? b` (0 when false), `loop`,
// `for_each`, `temp.` variables and case-insensitive namespaces. Compiling a
// real parse tree keeps the game's semantics instead of guessing with regexes.
//
// The generated function is called as fn(v, ysm, query, ctrl, math, t, ctx, H);
// H supplies runtime helpers (g*/s* variable access, value, lookup, truthy,
// call, member, loop, forEach).

const NAMESPACES={v:'v',variable:'v',t:'t',temp:'t',q:'query',query:'query',math:'math',ysm:'ysm',ctrl:'ctrl',c:'ctx',context:'ctx',geometry:'ctx',texture:'ctx',material:'ctx'};
const OPERATORS=['&&','||','??','==','!=','<=','>=','->','=','<','>','+','-','*','/','!','?',':',';',',','(',')','{','}','[',']','.'];

function tokenize(source){
  const tokens=[];let i=0;
  while(i<source.length){
    const ch=source[i];
    if(/\s/.test(ch)){i++;continue;}
    if(/[0-9]/.test(ch)||(ch==='.'&&/[0-9]/.test(source[i+1]||''))){
      const match=/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?f?/i.exec(source.slice(i));
      tokens.push({type:'num',value:Number(match[0].replace(/f$/i,''))});i+=match[0].length;continue;
    }
    if(ch==="'"||ch==='"'){
      const end=source.indexOf(ch,i+1);if(end<0)throw new Error('unterminated string');
      tokens.push({type:'str',value:source.slice(i+1,end)});i=end+1;continue;
    }
    if(/[A-Za-z_$]/.test(ch)){
      const match=/^[A-Za-z_$][\w$]*/.exec(source.slice(i));
      tokens.push({type:'id',value:match[0]});i+=match[0].length;continue;
    }
    const op=OPERATORS.find(item=>source.startsWith(item,i));
    if(!op)throw new Error(`unexpected character ${ch}`);
    tokens.push({type:'op',value:op});i+=op.length;
  }
  tokens.push({type:'eof'});
  return tokens;
}

// Binding powers, low to high. Assignment and both conditionals are right-associative.
const BINARY={'=':1,'?':2,'??':3,'||':4,'&&':5,'==':6,'!=':6,'<':7,'<=':7,'>':7,'>=':7,'+':8,'-':8,'*':9,'/':9};

class Parser {
  constructor(tokens){this.tokens=tokens;this.pos=0;}
  peek(){return this.tokens[this.pos];}
  next(){return this.tokens[this.pos++];}
  isOp(value){const token=this.peek();return token.type==='op'&&token.value===value;}
  expectOp(value){if(!this.isOp(value))throw new Error(`expected ${value}`);this.next();}
  isKeyword(name){const token=this.peek();return token.type==='id'&&token.value.toLowerCase()===name;}
  program(){
    const statements=[];
    while(this.peek().type!=='eof'){
      if(this.isOp(';')){this.next();continue;}
      statements.push(this.statement());
      if(!this.isOp(';')&&this.peek().type!=='eof')throw new Error('expected ;');
    }
    return statements;
  }
  block(){
    this.expectOp('{');const statements=[];
    while(!this.isOp('}')){
      if(this.peek().type==='eof')throw new Error('unterminated block');
      if(this.isOp(';')){this.next();continue;}
      statements.push(this.statement());
    }
    this.next();
    return {type:'block',statements};
  }
  statement(){
    if(this.isKeyword('return')){this.next();return {type:'return',value:this.expression(0)};}
    if(this.isKeyword('break')){this.next();return {type:'break'};}
    if(this.isKeyword('continue')){this.next();return {type:'continue'};}
    return {type:'expr',value:this.expression(0)};
  }
  expression(minPower){
    let left=this.unary();
    for(;;){
      const token=this.peek();
      if(token.type!=='op'||!(token.value in BINARY))break;
      const power=BINARY[token.value];
      if(power<minPower)break;
      this.next();
      if(token.value==='?'){
        const whenTrue=this.expression(power);
        if(this.isOp(':')){this.next();left={type:'ternary',test:left,whenTrue,whenFalse:this.expression(power)};}
        else left={type:'ternary',test:left,whenTrue,whenFalse:{type:'num',value:0}};
        continue;
      }
      const rightAssoc=token.value==='=';
      left={type:'binary',op:token.value,left,right:this.expression(rightAssoc?power:power+1)};
    }
    return left;
  }
  unary(){
    if(this.isOp('!')){this.next();return {type:'not',value:this.unary()};}
    if(this.isOp('-')){this.next();return {type:'neg',value:this.unary()};}
    if(this.isOp('+')){this.next();return this.unary();}
    return this.postfix(this.primary());
  }
  postfix(node){
    for(;;){
      if(this.isOp('.')){this.next();const name=this.next();if(name.type!=='id')throw new Error('expected name');node=node.type==='path'?{...node,keys:[...node.keys,name.value]}:{type:'member',object:node,key:name.value};continue;}
      if(this.isOp('(')){
        this.next();const args=[];
        while(!this.isOp(')')){args.push(this.isOp('{')?this.block():this.expression(0));if(this.isOp(','))this.next();else if(!this.isOp(')'))throw new Error('expected )');}
        this.next();node={type:'call',callee:node,args};continue;
      }
      if(this.isOp('[')){this.next();const index=this.expression(0);this.expectOp(']');node={type:'index',object:node,index};continue;}
      if(this.isOp('->')){this.next();this.unary();node={type:'num',value:0};continue;}
      return node;
    }
  }
  primary(){
    const token=this.next();
    if(token.type==='num')return {type:'num',value:token.value};
    if(token.type==='str')return {type:'str',value:token.value};
    if(token.type==='op'&&token.value==='('){const value=this.expression(0);this.expectOp(')');return value;}
    if(token.type==='op'&&token.value==='{'){this.pos--;return this.block();}
    if(token.type==='id'){
      const name=token.value.toLowerCase();
      if(name==='true')return {type:'num',value:1};
      if(name==='false')return {type:'num',value:0};
      if(name==='loop'||name==='for_each')return {type:'keyword',name};
      if(name in NAMESPACES)return {type:'path',root:NAMESPACES[name],keys:[]};
      return {type:'path',root:null,keys:[token.value]};
    }
    throw new Error('unexpected token');
  }
}

const jsKey=key=>JSON.stringify(key);
const pathCode=node=>node.root+node.keys.map(key=>`[${jsKey(key)}]`).join('');

// Variable roots other than math are plain storage objects (see
// ysm-animation.js). Reads walk them without creating anything: a missing key
// is an unset variable and reads as 0. Writes create intermediate structs.
// Fixed-arity helpers keep the per-frame hot path free of array allocations.
function useRoot(root,ctx){if(root==='t')ctx.usesTemp=true;else if(root==='ctx')ctx.usesContext=true;}
function readCode(node,ctx){
  useRoot(node.root,ctx);
  if(node.root==='math')return `H.value(${pathCode(node)})`;
  const keys=node.keys.map(jsKey);
  return keys.length<=3?`H.g${keys.length}(${node.root},${keys.join(',')})`:`H.gn(${node.root},[${keys.join(',')}])`;
}
function writeCode(node,value,ctx){
  useRoot(node.root,ctx);
  if(node.root==='math')return `(${pathCode(node)}=${value})`;
  const keys=node.keys.map(jsKey);
  return keys.length<=3?`H.s${keys.length}(${node.root},${keys.join(',')},${value})`:`H.sn(${node.root},[${keys.join(',')}],${value})`;
}

function generate(node,ctx){
  switch(node.type){
    case 'num':return String(node.value);
    case 'str':return JSON.stringify(node.value);
    case 'path':
      if(!node.root||!node.keys.length)return '0';
      return readCode(node,ctx);
    case 'member':return `H.member(${generate(node.object,ctx)},${jsKey(node.key)})`;
    case 'index':return `H.member(${generate(node.object,ctx)},${generate(node.index,ctx)})`;
    case 'not':return `(H.truthy(${generate(node.value,ctx)})?0:1)`;
    case 'neg':return `(-H.num(${generate(node.value,ctx)}))`;
    case 'ternary':return `(H.truthy(${generate(node.test,ctx)})?${generate(node.whenTrue,ctx)}:${generate(node.whenFalse,ctx)})`;
    case 'block':return `(()=>{${statements(node.statements,ctx,true)}})`;
    case 'keyword':return '0';
    case 'call':{
      const callee=node.callee;
      if(callee.type==='keyword'&&callee.name==='loop')return `H.loop(${generate(node.args[0]||{type:'num',value:0},ctx)},${generate(node.args[1]||{type:'block',statements:[]},ctx)})`;
      if(callee.type==='keyword'&&callee.name==='for_each'){
        const target=node.args[0];if(target?.type!=='path'||!target.root)return '0';
        return `H.forEach(${generate(node.args[1]||{type:'num',value:0},ctx)},(item)=>{${writeCode(target,'item',ctx)};},${generate(node.args[2]||{type:'block',statements:[]},ctx)})`;
      }
      const args=`[${node.args.map(arg=>generate(arg,ctx)).join(',')}]`;
      if(callee.type==='path'&&callee.root&&callee.keys.length){
        const owner={...callee,keys:callee.keys.slice(0,-1)};
        useRoot(owner.root,ctx);
        const ownerCode=!owner.keys.length?owner.root:owner.root==='math'?pathCode(owner):`H.owner(${owner.root},${JSON.stringify(owner.keys)})`;
        return `H.call(${ownerCode},${jsKey(callee.keys.at(-1))},${args})`;
      }
      return '0';
    }
    case 'binary':{
      const {op,left,right}=node;
      if(op==='='){
        if(left.type!=='path'||!left.root||!left.keys.length)throw new Error('invalid assignment target');
        return writeCode(left,generate(right,ctx),ctx);
      }
      if(op==='??'){
        const fallback=generate(right,ctx);
        if(left.type==='path'&&left.root&&left.keys.length){useRoot(left.root,ctx);return `(H.lookup(${left.root},${JSON.stringify(left.keys)})??${fallback})`;}
        return `(${generate(left,ctx)}??${fallback})`;
      }
      const a=generate(left,ctx),b=generate(right,ctx);
      if(op==='&&')return `((H.truthy(${a})&&H.truthy(${b}))?1:0)`;
      if(op==='||')return `((H.truthy(${a})||H.truthy(${b}))?1:0)`;
      if(op==='=='||op==='!=')return `((${a}${op}${b})?1:0)`;
      // YSM coerces operands with ValueConversions.asFloat (NaN → 0) and defines x/0 as 0.
      if(['<','<=','>','>='].includes(op))return `((H.num(${a})${op}H.num(${b}))?1:0)`;
      if(op==='/')return `H.div(${a},${b})`;
      return `(H.num(${a})${op}H.num(${b}))`;
    }
  }
  throw new Error(`unsupported ${node.type}`);
}

function statements(list,ctx,inLoop){
  return list.map(statement=>{
    if(statement.type==='return')return `return ${generate(statement.value,ctx)};`;
    if(statement.type==='break')return inLoop?'return H.BREAK;':'';
    if(statement.type==='continue')return inLoop?'return;':'';
    return `${generate(statement.value,ctx)};`;
  }).join('');
}

/** Compiles Molang source into a JS function body; throws on syntax errors. */
export function compileMolang(source){
  const parser=new Parser(tokenize(String(source)));
  const program=parser.program(),ctx={usesTemp:false,usesContext:false};
  // YSM's ExpressionEvaluatorImpl.evalAll() yields the last statement's value
  // unless a `return` runs first (stricter Bedrock Molang would yield 0).
  const body=program.map(statement=>statement.type==='expr'?`R=${generate(statement.value,ctx)};`:statements([statement],ctx,false)).join('');
  return {body:`let R=0;${body}return R;`,usesTemp:ctx.usesTemp,usesContext:ctx.usesContext};
}
