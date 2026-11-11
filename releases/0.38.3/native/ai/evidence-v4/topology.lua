-- Public terrain only. Grid routes are estimates, NEVER native navigation proof.
-- Sampling is incremental; a missing route means unknown, not an impassable map.
local function distance(a,b)return math.sqrt((a[1]-b[1])^2+(a[3]-b[3])^2)end
local function clamp(v,a,b)return math.max(a,math.min(b,v))end
local Grid={}
function Create(map,sample)
    local x0,z0,x1,z1=map.ownStart[1],map.ownStart[3],map.ownStart[1],map.ownStart[3]
    for _,list in ipairs({map.candidateStarts or{},map.massSites or{}})do for _,s in ipairs(list)do
        x0=math.min(x0,s.position[1]);x1=math.max(x1,s.position[1]);z0=math.min(z0,s.position[3]);z1=math.max(z1,s.position[3])
    end end
    local span=math.max(x1-x0,z1-z0);local radius=span*.5+math.max(48,span*.2)
    local cx,cz=(x0+x1)*.5,(z0+z1)*.5
    -- A horizontal spawn pair still needs room to discover a north/south detour.
    x0=clamp(cx-radius,0,map.width);x1=clamp(cx+radius,0,map.width)
    z0=clamp(cz-radius,0,map.height);z1=clamp(cz+radius,0,map.height)
    return setmetatable({n=25,x0=x0,z0=z0,dx=math.max(.1,(x1-x0)/24),dz=math.max(.1,(z1-z0)/24),
        sample=sample,cells={},next=1,cache={},cacheKeys={},wet=0,revision=0}, {__index=Grid})
end
function Grid:Step(budget)
    -- At most six new path searches per controller decision, including alternate
    -- corridors. Cached routes remain available after the budget is exhausted.
    self.searches=0
    if self.ready then return true end
    for i=1,math.min(128,budget or 64)do
        local id=self.next;if id>self.n*self.n then self.ready=true;self.revision=1;return true end
        local x,z=(id-1)%self.n,math.floor((id-1)/self.n)
        local px,pz=self.x0+x*self.dx,self.z0+z*self.dz
        local h,s=self.sample(px,pz)
        if type(h)~='number'or h~=h or math.abs(h)==math.huge or type(s)~='number'or s~=s or math.abs(s)==math.huge then return false end
        self.cells[id]={id=id,x=x,z=z,p={px,h,pz},wet=s-h>.5};if s-h>.5 then self.wet=self.wet+1 end
        self.next=id+1
    end
    return false
end
function Grid:Index(p)
    local x,z=math.floor((p[1]-self.x0)/self.dx+.5),math.floor((p[3]-self.z0)/self.dz+.5)
    if x<0 or z<0 or x>=self.n or z>=self.n then return end
    return z*self.n+x+1
end
function Grid:Allowed(a,b,layer)
    if not a or not b then return false end
    if layer=='naval'then return a.wet and b.wet end
    if a.wet or b.wet then return false end
    return math.abs(a.p[2]-b.p[2])<=distance(a.p,b.p)*.55
end
function Grid:Neighbors(id,layer)
    local a=self.cells[id];local out={}
    for dz=-1,1 do for dx=-1,1 do if dx~=0 or dz~=0 then
        local x,z=a.x+dx,a.z+dz
        if x>=0 and x<self.n and z>=0 and z<self.n then
            local b=self.cells[z*self.n+x+1]
            if self:Allowed(a,b,layer)and(dx==0 or dz==0 or
                self:Allowed(a,self.cells[a.z*self.n+x+1],layer)and self:Allowed(a,self.cells[z*self.n+a.x+1],layer))then out[#out+1]=b.id end
        end
    end end end
    return out
end
local function push(heap,id,cost)
    local i=#heap+1;local item={id=id,cost=cost}
    while i>1 do local p=math.floor(i/2);local other=heap[p]
        if other.cost<cost or other.cost==cost and other.id<id then break end
        heap[i]=other;i=p
    end
    heap[i]=item
end
local function pop(heap)
    local first=heap[1];local last=table.remove(heap)
    if #heap>0 then
        local i=1
        while i*2<=#heap do
            local c=i*2
            if heap[c+1]and(heap[c+1].cost<heap[c].cost or heap[c+1].cost==heap[c].cost and heap[c+1].id<heap[c].id)then c=c+1 end
            if last.cost<heap[c].cost or last.cost==heap[c].cost and last.id<heap[c].id then break end
            heap[i]=heap[c];i=c
        end
        heap[i]=last
    end
    return first
end
function Grid:Search(first,last,layer,blocked)
    if (self.searches or 0)>=6 then return nil,nil,'route-budget'end
    self.searches=(self.searches or 0)+1
    local a,b=self.cells[first],self.cells[last]
    if not a or not b or(layer=='naval'and(not a.wet or not b.wet))or(layer~='naval'and(a.wet or b.wet))then return end
    local dist,previous,closed={[first]=0},{},{};local heap={};push(heap,first,0)
    while #heap>0 do
        local node=pop(heap);local id=node.id
        if not closed[id]then
            closed[id]=true
            if id==last then
                local ids={id};while previous[id]do id=previous[id];table.insert(ids,1,id)end
                return ids,dist[last]
            end
            for _,other in ipairs(self:Neighbors(id,layer))do if not closed[other]and not(blocked and blocked[other])then
                local cost=dist[id]+distance(self.cells[id].p,self.cells[other].p)
                if not dist[other]or cost<dist[other]then dist[other]=cost;previous[other]=id;push(heap,other,cost)end
            end end
        end
    end
end
function Grid:Route(a,b,layer)
    if layer=='air'then return{length=distance(a,b),points={a,b},estimated=true,chokes=0,flanks=0}end
    if not self.ready then return nil,'terrain-sampling'end
    local first,last=self:Index(a),self:Index(b)
    if not first or not last then return nil,'outside-sampled-region'end
    local key=layer..':'..first..':'..last
    local r=self.cache[key]
    if r==false then return nil,'no-coarse-route'end
    if not r then
        if (self.searches or 0)>4 then return nil,'route-budget'end
        local ids,length,why=self:Search(first,last,layer)
        if why then return nil,why end
        if not ids then
            self.cache[key]=false;self.cacheKeys[#self.cacheKeys+1]=key
            if #self.cacheKeys>64 then self.cache[table.remove(self.cacheKeys,1)]=nil end
            return nil,'no-coarse-route'
        end
        local narrow,blocked=0,{}
        for i=3,#ids-2 do
            if #self:Neighbors(ids[i],layer)<=4 then narrow=narrow+1 end
        end
        -- An alternate must bypass the middle corridor, not just wobble a cell.
        local center=ids[math.max(1,math.floor(#ids/2))]
        if #ids>7 then blocked[center]=true;for _,id in ipairs(self:Neighbors(center,layer))do blocked[id]=true end end
        local alternate,altLength
        if #ids>7 then alternate,altLength=self:Search(first,last,layer,blocked)end
        r={ids=ids,length=length,estimated=true,chokes=math.min(3,math.ceil(narrow/3)),
            flanks=alternate and altLength<=length*1.65 and 1 or 0}
        self.cache[key]=r;self.cacheKeys[#self.cacheKeys+1]=key
        if #self.cacheKeys>64 then self.cache[table.remove(self.cacheKeys,1)]=nil end
    end
    local points={a}
    for i=2,#r.ids-1 do
        local before,here,after=self.cells[r.ids[i-1]],self.cells[r.ids[i]],self.cells[r.ids[i+1]]
        if here.x-before.x~=after.x-here.x or here.z-before.z~=after.z-here.z then points[#points+1]=here.p end
    end
    points[#points+1]=b
    -- Never simplify across obstacles merely to fit a command/route budget.
    if #points>32 then return nil,'coarse-route-too-complex'end
    return{length=math.max(distance(a,b),r.length+distance(a,self.cells[first].p)+distance(b,self.cells[last].p)),
        points=points,estimated=true,chokes=r.chokes,flanks=r.flanks}
end
function Grid:Summary(map,speed)
    if not self.ready then return nil end
    local nearest,chokes,flanks,routes=nil,0,0,0
    for _,s in ipairs(map.candidateStarts or{})do
        -- Native reachability comes from the existing owned navigator adapter.
        if s.land and s.land.reachable then
            local r=self:Route(map.ownStart,s.position,'land')
            if r then nearest=math.min(nearest or math.huge,r.length/math.max(.1,speed or 3));chokes=math.max(chokes,r.chokes);flanks=math.max(flanks,r.flanks);routes=routes+1 end
        end
    end
    return{travelSeconds=nearest,chokes=chokes,flanks=flanks,waterFraction=self.wet/(self.n*self.n),
        routes=routes,estimated=true,revision=self.revision}
end
