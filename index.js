require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const fs = require('fs-extra');
const multer = require('multer');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// إنشاء البوت
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ]
});

// إنشاء المجلدات المطلوبة
const requiredDirs = ['views', 'models', 'public', 'bots', 'uploads', 'temp', 'logs'];
requiredDirs.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`📁 تم إنشاء مجلد: ${dir}`);
    }
});

// النماذج
const User = require('./models/User');
const Bot = require('./models/Bot');
const AuthSession = require('./models/AuthSession');

// إعدادات التطبيق
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// إعداد الجلسات مع التخزين في MongoDB
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        collectionName: 'sessions',
        ttl: 24 * 60 * 60 // 24 ساعة
    }),
    cookie: { 
        secure: false,
        maxAge: 7 * 24 * 60 * 60 * 1000 // أسبوع كامل
    }
}));

// إعداد رفع الملفات
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userDir = path.join(__dirname, 'temp', req.session.userId || 'guest');
        fs.ensureDirSync(userDir);
        cb(null, userDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

// وسيط المصادقة
const requireAuth = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login');
    }
};

// تخزين عمليات البوتات
const botProcesses = new Map();

// ========== مسارات الموقع ==========

app.get('/', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.render('index', { 
        title: 'منصة استضافة بوتات الديسكورد',
        user: null 
    });
});

app.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.render('login', { 
        title: 'تسجيل الدخول',
        error: null,
        success: null
    });
});

app.post('/login', async (req, res) => {
    try {
        const { code } = req.body;
        
        if (!code) {
            return res.render('login', {
                title: 'تسجيل الدخول',
                error: 'يرجى إدخال كود التحقق',
                success: null
            });
        }

        const cleanCode = code.trim().toUpperCase();
        const authSession = await AuthSession.findOne({ 
            code: cleanCode,
            used: false 
        });

        if (!authSession) {
            return res.render('login', {
                title: 'تسجيل الدخول',
                error: 'كود التحقق غير صحيح',
                success: null
            });
        }

        let user = await User.findOne({ discordId: authSession.discordId });
        
        if (!user) {
            user = new User({
                discordId: authSession.discordId,
                username: authSession.username,
                avatar: authSession.avatar,
                tier: 'free'
            });
            await user.save();
        }

        authSession.used = true;
        authSession.usedAt = new Date();
        await authSession.save();

        req.session.userId = user._id;
        req.session.discordId = user.discordId;
        req.session.username = user.username;
        req.session.tier = user.tier;
        
        console.log(`✅ تسجيل دخول: ${user.username}`);
        
        res.redirect('/dashboard');
    } catch (error) {
        console.error('❌ خطأ في تسجيل الدخول:', error);
        res.render('login', {
            title: 'تسجيل الدخول',
            error: 'حدث خطأ أثناء تسجيل الدخول',
            success: null
        });
    }
});

app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        const bots = await Bot.find({ owner: req.session.userId });
        
        const stats = {
            totalBots: bots.length,
            runningBots: bots.filter(bot => bot.status === 'running').length,
            stoppedBots: bots.filter(bot => bot.status === 'stopped').length
        };
        
        res.render('dashboard', {
            title: 'لوحة التحكم',
            user: req.session,
            bots: bots,
            stats: stats,
            botLimit: getBotLimit(req.session.tier)
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.redirect('/login');
    }
});

// ========== مسارات إدارة البوتات ==========

// صفحة تفاصيل البوت
app.get('/bot/:id', requireAuth, async (req, res) => {
    try {
        // التحقق من صحة ID
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(404).render('404', {
                title: 'البوت غير موجود',
                user: req.session
            });
        }

        const bot = await Bot.findOne({ _id: req.params.id, owner: req.session.userId });
        
        if (!bot) {
            return res.status(404).render('404', {
                title: 'البوت غير موجود',
                user: req.session
            });
        }

        console.log(`📁 جاري تحميل ملفات البوت: ${bot.name}`);

        // قراءة ملفات البوت مع معالجة الأخطاء
        let files = [];
        try {
            if (fs.existsSync(bot.path)) {
                files = await getDirectoryStructure(bot.path);
                console.log(`✅ تم تحميل ${files.length} ملف/مجلد`);
            } else {
                console.log(`📁 إنشاء مجلد البوت: ${bot.path}`);
                await fs.ensureDir(bot.path);
                files = [];
            }
        } catch (filesError) {
            console.error('❌ خطأ في تحميل الملفات:', filesError.message);
            files = [];
        }
        
        res.render('bot-details', {
            title: `إدارة ${bot.name}`,
            user: req.session,
            bot: bot,
            files: files,
            isRunning: botProcesses.has(bot._id.toString())
        });
    } catch (error) {
        console.error('Bot details error:', error);
        res.status(500).send('حدث خطأ أثناء تحميل صفحة البوت');
    }
});

// الحصول على ملفات البوت
app.get('/bot/:id/files', requireAuth, async (req, res) => {
    try {
        const bot = await Bot.findOne({ _id: req.params.id, owner: req.session.userId });
        
        if (!bot) {
            return res.status(404).json({ success: false, message: 'البوت غير موجود' });
        }

        let files = [];
        if (fs.existsSync(bot.path)) {
            files = await getDirectoryStructure(bot.path);
        }
        
        res.json({ success: true, files: files });
    } catch (error) {
        console.error('Get files error:', error);
        res.status(500).json({ success: false, message: 'حدث خطأ أثناء جلب الملفات' });
    }
});

// قراءة محتوى ملف
app.get('/bot/:id/file', requireAuth, async (req, res) => {
    try {
        const { filePath } = req.query;
        const bot = await Bot.findOne({ _id: req.params.id, owner: req.session.userId });
        
        if (!bot) {
            return res.status(404).json({ success: false, message: 'البوت غير موجود' });
        }
        
        const fullPath = path.join(bot.path, filePath);
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, message: 'الملف غير موجود' });
        }
        
        const content = await fs.readFile(fullPath, 'utf8');
        res.json({ success: true, content: content });
    } catch (error) {
        console.error('Read file error:', error);
        res.status(500).json({ success: false, message: 'حدث خطأ أثناء قراءة الملف' });
    }
});

// حفظ محتوى ملف
app.post('/bot/:id/file', requireAuth, async (req, res) => {
    try {
        const { filePath, content } = req.body;
        const bot = await Bot.findOne({ _id: req.params.id, owner: req.session.userId });
        
        if (!bot) {
            return res.status(404).json({ success: false, message: 'البوت غير موجود' });
        }
        
        const fullPath = path.join(bot.path, filePath);
        await fs.writeFile(fullPath, content, 'utf8');
        
        res.json({ success: true, message: 'تم حفظ الملف بنجاح' });
    } catch (error) {
        console.error('Write file error:', error);
        res.status(500).json({ success: false, message: 'حدث خطأ أثناء حفظ الملف' });
    }
});

// تحميل ملف
app.get('/bot/:id/download', requireAuth, async (req, res) => {
    try {
        const { filePath } = req.query;
        const bot = await Bot.findOne({ _id: req.params.id, owner: req.session.userId });
        
        if (!bot) {
            return res.status(404).json({ success: false, message: 'البوت غير موجود' });
        }
        
        const fullPath = path.join(bot.path, filePath);
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, message: 'الملف غير موجود' });
        }
        
        res.download(fullPath);
    } catch (error) {
        console.error('Download file error:', error);
        res.status(500).json({ success: false, message: 'حدث خطأ أثناء تحميل الملف' });
    }
});

// حذف ملف
app.delete('/bot/:id/file', requireAuth, async (req, res) => {
    try {
        const { filePath } = req.body;
        const bot = await Bot.findOne({ _id: req.params.id, owner: req.session.userId });
        
        if (!bot) {
            return res.status(404).json({ success: false, message: 'البوت غير موجود' });
        }
        
        const fullPath = path.join(bot.path, filePath);
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, message: 'الملف غير موجود' });
        }
        
        await fs.remove(fullPath);
        
        res.json({ success: true, message: 'تم حذف الملف بنجاح' });
    } catch (error) {
        console.error('Delete file error:', error);
        res.status(500).json({ success: false, message: 'حدث خطأ أثناء حذف الملف' });
    }
});

// رفع ملفات إضافية للبوت
app.post('/bot/:id/upload', requireAuth, upload.array('files'), async (req, res) => {
    try {
        const bot = await Bot.findOne({ _id: req.params.id, owner: req.session.userId });
        
        if (!bot) {
            return res.status(404).json({ success: false, message: 'البوت غير موجود' });
        }
        
        for (const file of req.files) {
            const destPath = path.join(bot.path, file.originalname);
            await fs.move(file.path, destPath, { overwrite: true });
        }
        
        res.json({ success: true, message: 'تم رفع الملفات بنجاح' });
    } catch (error) {
        console.error('Upload files error:', error);
        res.status(500).json({ success: false, message: 'حدث خطأ أثناء رفع الملفات' });
    }
});

// إنشاء بوت جديد
app.post('/bot/create', requireAuth, upload.single('botFile'), async (req, res) => {
    try {
        const { botName, botCode } = req.body;
        
        if (!botName) {
            return res.json({ success: false, message: 'يرجى إدخال اسم البوت' });
        }

        // التحقق من الحد الأقصى
        const userBots = await Bot.countDocuments({ owner: req.session.userId });
        const botLimit = getBotLimit(req.session.tier);
        
        if (userBots >= botLimit) {
            return res.json({
                success: false,
                message: `لقد وصلت إلى الحد الأقصى للبوتات (${botLimit})`
            });
        }

        // إنشاء مجلد البوت
        const botDir = path.join(__dirname, 'bots', req.session.userId.toString(), botName);
        await fs.ensureDir(botDir);

        if (req.file) {
            // معالجة الملف المرفوع
            const fileExtension = path.extname(req.file.originalname).toLowerCase();
            
            if (fileExtension === '.zip') {
                const zip = new AdmZip(req.file.path);
                zip.extractAllTo(botDir, true);
                console.log(`📦 تم استخراج ZIP إلى: ${botDir}`);
            } else {
                const destPath = path.join(botDir, req.file.originalname);
                await fs.move(req.file.path, destPath);
                console.log(`📄 تم نسخ الملف إلى: ${destPath}`);
            }
            
            await fs.remove(req.file.path);
        } else if (botCode) {
            // حفظ الكود
            const botFilePath = path.join(botDir, 'index.js');
            await fs.writeFile(botFilePath, botCode);
            console.log(`💾 تم حفظ كود البوت: ${botFilePath}`);
        } else {
            return res.json({ success: false, message: 'يرجى رفع ملف أو إدخال كود' });
        }

        // إنشاء package.json
        const packageJson = {
            name: botName.toLowerCase().replace(/\s+/g, '-'),
            version: '1.0.0',
            description: 'Discord Bot',
            main: 'index.js',
            dependencies: {
                'discord.js': '^14.0.0'
            },
            scripts: {
                start: 'node index.js'
            }
        };
        
        await fs.writeFile(
            path.join(botDir, 'package.json'), 
            JSON.stringify(packageJson, null, 2)
        );

        // إنشاء البوت في قاعدة البيانات
        const bot = new Bot({
            name: botName,
            owner: req.session.userId,
            path: botDir,
            status: 'stopped',
            createdAt: new Date()
        });

        await bot.save();

        res.json({
            success: true,
            message: 'تم إنشاء البوت بنجاح',
            botId: bot._id
        });
    } catch (error) {
        console.error('Bot creation error:', error);
        res.json({
            success: false,
            message: 'حدث خطأ أثناء إنشاء البوت: ' + error.message
        });
    }
});

// تشغيل البوت
app.post('/bot/:id/start', requireAuth, async (req, res) => {
    try {
        const bot = await Bot.findOne({ _id: req.params.id, owner: req.session.userId });
        
        if (!bot) {
            return res.json({ success: false, message: 'البوت غير موجود' });
        }

        if (botProcesses.has(bot._id.toString())) {
            return res.json({ success: true, message: 'البوت يعمل بالفعل' });
        }

        const mainFile = await findMainFile(bot.path);
        if (!mainFile) {
            return res.json({ success: false, message: 'لم يتم العثور على ملف البوت الرئيسي' });
        }

        // تشغيل البوت
        const botProcess = spawn('node', [mainFile], {
            cwd: bot.path,
            stdio: 'pipe'
        });

        botProcesses.set(bot._id.toString(), botProcess);

        botProcess.stdout.on('data', (data) => {
            console.log(`[${bot.name}] ${data}`);
        });

        botProcess.stderr.on('data', (data) => {
            console.error(`[${bot.name}] ${data}`);
        });

        botProcess.on('close', (code) => {
            console.log(`[${bot.name}] تم إيقاف البوت برمز: ${code}`);
            botProcesses.delete(bot._id.toString());
            Bot.findByIdAndUpdate(bot._id, { status: 'stopped' }).exec();
        });

        bot.status = 'running';
        bot.lastStarted = new Date();
        await bot.save();

        res.json({ 
            success: true, 
            message: 'تم بدء تشغيل البوت',
            status: 'running'
        });
    } catch (error) {
        console.error('Start bot error:', error);
        res.json({ success: false, message: 'حدث خطأ أثناء بدء التشغيل' });
    }
});

// إيقاف البوت
app.post('/bot/:id/stop', requireAuth, async (req, res) => {
    try {
        const bot = await Bot.findOne({ _id: req.params.id, owner: req.session.userId });
        
        if (!bot) {
            return res.json({ success: false, message: 'البوت غير موجود' });
        }

        if (botProcesses.has(bot._id.toString())) {
            const botProcess = botProcesses.get(bot._id.toString());
            botProcess.kill('SIGTERM');
            botProcesses.delete(bot._id.toString());
        }

        bot.status = 'stopped';
        bot.lastStopped = new Date();
        await bot.save();

        res.json({ 
            success: true, 
            message: 'تم إيقاف البوت',
            status: 'stopped'
        });
    } catch (error) {
        console.error('Stop bot error:', error);
        res.json({ success: false, message: 'حدث خطأ أثناء الإيقاف' });
    }
});

// حذف البوت
app.post('/bot/:id/delete', requireAuth, async (req, res) => {
    try {
        const bot = await Bot.findOne({ _id: req.params.id, owner: req.session.userId });
        
        if (!bot) {
            return res.json({ success: false, message: 'البوت غير موجود' });
        }

        // إيقاف البوت إذا كان يعمل
        if (botProcesses.has(bot._id.toString())) {
            const botProcess = botProcesses.get(bot._id.toString());
            botProcess.kill('SIGTERM');
            botProcesses.delete(bot._id.toString());
        }

        // حذف مجلد البوت
        try {
            await fs.remove(bot.path);
        } catch (fsError) {
            console.error('Error deleting bot folder:', fsError);
        }

        // حذف البوت من قاعدة البيانات
        await Bot.findByIdAndDelete(bot._id);

        res.json({ 
            success: true, 
            message: 'تم حذف البوت بنجاح'
        });
    } catch (error) {
        console.error('Delete bot error:', error);
        res.json({ success: false, message: 'حدث خطأ أثناء حذف البوت' });
    }
});

// مسار للتحقق من صحة النظام
app.get('/health', async (req, res) => {
    try {
        const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
        const botStatus = client.isReady() ? 'ready' : 'not ready';
        const totalUsers = await User.countDocuments();
        const totalBots = await Bot.countDocuments();
        
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            database: dbStatus,
            discord_bot: botStatus,
            statistics: {
                users: totalUsers,
                bots: totalBots,
                active_processes: botProcesses.size
            }
        });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

app.get('/logout', (req, res) => {
    const username = req.session.username;
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        } else {
            console.log(`✅ تسجيل خروج: ${username}`);
        }
        res.redirect('/');
    });
});

// صفحة 404
app.use('*', (req, res) => {
    res.status(404).render('404', {
        title: 'الصفحة غير موجودة',
        user: req.session || null
    });
});
// مسار السجلات الرئيسي
app.get('/logs', requireAuth, async (req, res) => {
    try {
        const { page = 1, level, search, startDate, endDate } = req.query;
        
        const filters = { userId: req.session.userId };
        if (level && level !== 'all') filters.level = level;
        if (search) filters.search = search;
        if (startDate) filters.startDate = startDate;
        if (endDate) filters.endDate = endDate;

        const logsData = await Logger.getLogs(filters, parseInt(page), 50);

        res.render('logs', {
            title: 'سجلات النظام',
            user: req.session,
            logs: logsData.logs,
            pagination: logsData.pagination,
            filters: { level, search, startDate, endDate }
        });
    } catch (error) {
        console.error('Logs page error:', error);
        res.status(500).send('حدث خطأ أثناء تحميل السجلات');
    }
});

// سجلات بوت معين
app.get('/bot/:id/logs', requireAuth, async (req, res) => {
    try {
        const { page = 1, level, search } = req.query;
        const bot = await Bot.findOne({ _id: req.params.id, owner: req.session.userId });
        
        if (!bot) {
            return res.status(404).json({ success: false, message: 'البوت غير موجود' });
        }

        const filters = { botId: bot._id };
        if (level && level !== 'all') filters.level = level;
        if (search) filters.search = search;

        const logsData = await Logger.getLogs(filters, parseInt(page), 20);

        res.json({
            success: true,
            logs: logsData.logs,
            pagination: logsData.pagination
        });
    } catch (error) {
        console.error('Get logs error:', error);
        res.status(500).json({ success: false, message: 'حدث خطأ أثناء جلب السجلات' });
    }
});
// ========== بوت الديسكورد ==========

// تسجيل الأوامر
async function registerCommands() {
    try {
        const commands = [
            new SlashCommandBuilder()
                .setName('تحقق')
                .setDescription('إنشاء كود تحقق للدخول إلى لوحة التحكم')
                .toJSON(),
            new SlashCommandBuilder()
                .setName('بوتاتي')
                .setDescription('عرض البوتات التي تستضيفها')
                .toJSON(),
            new SlashCommandBuilder()
                .setName('احصائيات')
                .setDescription('عرض إحصائيات المنصة')
                .toJSON()
        ];

        const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
        
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: commands }
        );
        
        console.log('✅ تم تسجيل أوامر الديسكورد');
    } catch (error) {
        console.error('❌ خطأ في تسجيل الأوامر:', error);
    }
}

// عندما يكون البوت جاهز
client.once('ready', async () => {
    console.log(`✅ بوت الديسكورد جاهز: ${client.user.tag}`);
    await registerCommands();
    client.user.setActivity('منصة الاستضافة', { type: 'WATCHING' });
});

// معالجة الأوامر
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        switch (interaction.commandName) {
            case 'تحقق':
                await handleVerificationCommand(interaction);
                break;
            case 'بوتاتي':
                await handleMyBotsCommand(interaction);
                break;
            case 'احصائيات':
                await handleStatsCommand(interaction);
                break;
        }
    } catch (error) {
        console.error(`خطأ في الأمر ${interaction.commandName}:`, error);
        await interaction.reply({
            content: '❌ حدث خطأ أثناء تنفيذ الأمر',
            ephemeral: true
        });
    }
});

// أمر التحقق
async function handleVerificationCommand(interaction) {
    const code = generateCode();
    
    // مسح الجلسات القديمة لنفس المستخدم
    await AuthSession.updateMany(
        { discordId: interaction.user.id, used: false },
        { used: true }
    );

    const authSession = new AuthSession({
        code: code,
        discordId: interaction.user.id,
        username: interaction.user.username,
        avatar: interaction.user.displayAvatarURL({ extension: 'png', size: 256 })
    });

    await authSession.save();

    const embed = new EmbedBuilder()
        .setTitle('🔐 كود التحقق الخاص بك')
        .setDescription(`**استخدم هذا الكود لتسجيل الدخول إلى لوحة التحكم**`)
        .addFields(
            { name: '📟 الكود', value: `\`${code}\``, inline: false },
            { name: '⏰ الصلاحية', value: '5 دقائق', inline: true },
            { name: '🔢 الاستخدام', value: 'مرة واحدة', inline: true }
        )
        .setColor(0x0099FF)
        .setTimestamp()
        .setFooter({ 
            text: 'منصة استضافة بوتات الديسكورد',
            iconURL: client.user.displayAvatarURL()
        });

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setLabel('🌐 الذهاب للوحة التحكم')
                .setStyle(ButtonStyle.Link)
                .setURL('http://localhost:3000/login')
        );

    await interaction.reply({
        content: '✅ **تم إنشاء كود التحقق بنجاح!**',
        embeds: [embed],
        components: [row],
        ephemeral: true
    });

    try {
        await interaction.user.send({
            content: `🎉 **مرحباً ${interaction.user.username}!**\nها هو كود التحقق الخاص بك:`,
            embeds: [embed],
            components: [row]
        });
    } catch (error) {
        console.log('❌ لا يمكن إرسال رسالة خاصة للمستخدم');
    }
}

// أمر بوتاتي
async function handleMyBotsCommand(interaction) {
    const user = await User.findOne({ discordId: interaction.user.id });
    
    if (!user) {
        return await interaction.reply({
            content: '❌ لم تقم بتسجيل الدخول إلى لوحة التحكم بعد. استخدم أمر `/تحقق` أولاً.',
            ephemeral: true
        });
    }

    const bots = await Bot.find({ owner: user._id });

    if (bots.length === 0) {
        return await interaction.reply({
            content: '❌ ليس لديك أي بوتات مستضافة حالياً.',
            ephemeral: true
        });
    }

    const embed = new EmbedBuilder()
        .setTitle('🤖 البوتات الخاصة بك')
        .setDescription(`إجمالي البوتات: **${bots.length}**`)
        .setColor(0x00FF00)
        .setTimestamp();

    bots.forEach((bot, index) => {
        embed.addFields({
            name: `${index + 1}. ${bot.name}`,
            value: `الحالة: ${bot.status === 'running' ? '🟢 نشط' : '🔴 متوقف'}\nتاريخ الإنشاء: <t:${Math.floor(bot.createdAt.getTime() / 1000)}:R>`,
            inline: true
        });
    });

    await interaction.reply({
        embeds: [embed],
        ephemeral: true
    });
}

// أمر الإحصائيات
async function handleStatsCommand(interaction) {
    const totalUsers = await User.countDocuments();
    const totalBots = await Bot.countDocuments();
    const runningBots = await Bot.countDocuments({ status: 'running' });
    const stoppedBots = await Bot.countDocuments({ status: 'stopped' });

    const embed = new EmbedBuilder()
        .setTitle('📊 إحصائيات المنصة')
        .setColor(0xFFA500)
        .addFields(
            { name: '👥 إجمالي المستخدمين', value: totalUsers.toString(), inline: true },
            { name: '🤖 إجمالي البوتات', value: totalBots.toString(), inline: true },
            { name: '🟢 البوتات النشطة', value: runningBots.toString(), inline: true },
            { name: '🔴 البوتات المتوقفة', value: stoppedBots.toString(), inline: true },
            { name: '📈 نسبة التشغيل', value: `${Math.round((runningBots / totalBots) * 100) || 0}%`, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'منصة استضافة بوتات الديسكورد' });

    await interaction.reply({
        embeds: [embed],
        ephemeral: true
    });
}

// ========== الدوال المساعدة ==========

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function getBotLimit(tier) {
    const limits = { 'free': 1, 'premium': 5, 'ultimate': 10 };
    return limits[tier] || 1;
}

async function findMainFile(botDir) {
    const possibleFiles = ['index.js', 'app.js', 'main.js', 'bot.js'];
    
    for (const file of possibleFiles) {
        const filePath = path.join(botDir, file);
        if (fs.existsSync(filePath)) {
            return filePath;
        }
    }
    
    try {
        const files = await fs.readdir(botDir);
        const jsFiles = files.filter(f => f.endsWith('.js'));
        
        if (jsFiles.length > 0) {
            return path.join(botDir, jsFiles[0]);
        }
    } catch (error) {
        console.error('Error finding main file:', error);
    }
    
    return null;
}

async function getDirectoryStructure(dir) {
    try {
        if (!fs.existsSync(dir)) {
            console.log(`📁 إنشاء مجلد جديد: ${dir}`);
            await fs.ensureDir(dir);
            return [];
        }

        const items = await fs.readdir(dir);
        const structure = [];
        
        for (const item of items) {
            // تجاهل node_modules والمجلدات الكبيرة
            if (item === 'node_modules' || item.startsWith('.')) {
                continue;
            }

            const fullPath = path.join(dir, item);
            
            try {
                const stat = await fs.stat(fullPath);
                
                if (stat.isDirectory()) {
                    structure.push({
                        name: item,
                        path: item,
                        type: 'directory',
                        size: 0,
                        extension: ''
                    });
                } else {
                    structure.push({
                        name: item,
                        path: item,
                        type: 'file',
                        size: stat.size,
                        extension: path.extname(item).toLowerCase()
                    });
                }
            } catch (error) {
                console.log(`⚠️ تخطي: ${item}`, error.message);
            }
        }
        
        // ترتيب الملفات: مجلدات أولاً ثم ملفات
        structure.sort((a, b) => {
            if (a.type === 'directory' && b.type !== 'directory') return -1;
            if (a.type !== 'directory' && b.type === 'directory') return 1;
            return a.name.localeCompare(b.name);
        });
        
        return structure;
    } catch (error) {
        console.error('❌ خطأ في getDirectoryStructure:', error.message);
        return [];
    }
}

// ========== التشغيل ==========

async function startServer() {
    try {
        console.log('🚀 بدء تشغيل النظام...');
        
        // الاتصال بقاعدة البيانات
        await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        console.log('✅ تم الاتصال بقاعدة البيانات');

        // تشغيل بوت الديسكورد
        await client.login(process.env.TOKEN);
        
        // تشغيل الموقع
        const PORT = process.env.PORT || 3011;
        server.listen(PORT, () => {
            console.log(`🎉 النظام يعمل بالكامل!`);
            console.log(`🌐 الموقع: http://localhost:${PORT}`);
            console.log(`🤖 البوت: ${client.user.tag}`);
            console.log(`📊 تحقق من الصحة: http://localhost:${PORT}/health`);
            console.log(`⏰ وقت التشغيل: ${new Date().toLocaleString('ar-EG')}`);
        });
        
    } catch (error) {
        console.error('❌ خطأ في تشغيل النظام:', error);
        process.exit(1);
    }
}

// بدء التشغيل
startServer();

// معالجة الأخطاء
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ خطأ غير معالج:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ استثناء غير معالج:', error);
    process.exit(1);
});

process.on('SIGTERM', () => {
    console.log('🛑 استقبال إشارة إيقاف...');
    // إيقاف جميع عمليات البوتات
    botProcesses.forEach((process, botId) => {
        process.kill('SIGTERM');
    });
    process.exit(0);
});
