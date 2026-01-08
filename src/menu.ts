import inquirer from 'inquirer';
import { Logger } from 'telegram/extensions/Logger';

export interface GroupInfo {
    id: string;
    title: string;
    username?: string;
}

export class MenuSystem {
    constructor(private logger: Logger) {}

    async showMainMenu(): Promise<string> {
        console.clear();
        this.logger.info('===== Telegram 媒体下载器 =====\n');
        
        const { choice } = await inquirer.prompt([
            {
                type: 'list',
                name: 'choice',
                message: '请选择操作:',
                choices: [
                    { name: '[1] 开始下载 - 从保存的群组列表下载媒体', value: '1' },
                    { name: '[2] 调整同步群组 - 进入群组管理子菜单', value: '2' },
                    { name: '[3] 文件类型配置 - 修改下载文件类型', value: '3' },
                    { name: '[4] 其他设置 - 并发数、文件分类等', value: '4' },
                    { name: '[0] 退出程序', value: '0' },
                ],
            },
        ]);
        
        return choice;
    }

    async showGroupManagementMenu(currentGroups: GroupInfo[]): Promise<string> {
        console.clear();
        this.logger.info('===== 群组管理 =====\n');
        this.logger.info(`当前同步的群组 (${currentGroups.length} 个):`);
        
        if (currentGroups.length > 0) {
            currentGroups.forEach((group, index) => {
                this.logger.info(`[${index + 1}] ${group.title} (${group.id})`);
            });
        } else {
            this.logger.info('（暂无同步群组）');
        }
        
        this.logger.info('\n操作选项:');
        
        const { choice } = await inquirer.prompt([
            {
                type: 'list',
                name: 'choice',
                message: '请选择操作:',
                choices: [
                    { name: '[A] 添加群组到同步列表', value: 'A' },
                    { name: '[R] 移除某个群组', value: 'R' },
                    { name: '[C] 重新全选群组（重新初始化）', value: 'C' },
                    { name: '[0] 返回主菜单', value: '0' },
                ],
            },
        ]);
        
        return choice;
    }

    async selectGroups(
        availableGroups: GroupInfo[],
        preselectedIds: string[] = []
    ): Promise<string[]> {
        if (availableGroups.length === 0) {
            this.logger.warn('没有可用的群组');
            return [];
        }

        const { selectedIds } = await inquirer.prompt([
            {
                type: 'checkbox',
                name: 'selectedIds',
                message: '请选择要同步的群组 (按空格选择，按 Enter 确认):',
                choices: availableGroups.map(group => ({
                    name: `${group.title} (${group.id})`,
                    value: group.id,
                    checked: preselectedIds.includes(group.id),
                })),
                pageSize: 15,
            },
        ]);

        return selectedIds;
    }

    async selectGroupsToRemove(currentGroups: GroupInfo[]): Promise<string[]> {
        if (currentGroups.length === 0) {
            this.logger.warn('当前没有已同步的群组');
            return [];
        }

        const { selectedIds } = await inquirer.prompt([
            {
                type: 'checkbox',
                name: 'selectedIds',
                message: '请选择要移除的群组 (按空格选择，按 Enter 确认):',
                choices: currentGroups.map(group => ({
                    name: `${group.title} (${group.id})`,
                    value: group.id,
                })),
                pageSize: 15,
            },
        ]);

        return selectedIds;
    }

    async selectFileTypes(currentTypes: string[]): Promise<string[]> {
        console.clear();
        this.logger.info('===== 文件类型配置 =====\n');
        
        const { selectedTypes } = await inquirer.prompt([
            {
                type: 'checkbox',
                name: 'selectedTypes',
                message: '请选择要下载的文件类型 (按空格选择，按 Enter 确认):',
                choices: [
                    { name: 'photo  (图片)', value: 'photo', checked: currentTypes.includes('photo') },
                    { name: 'video  (视频)', value: 'video', checked: currentTypes.includes('video') },
                    { name: 'audio  (音频)', value: 'audio', checked: currentTypes.includes('audio') },
                    { name: 'file   (文件)', value: 'file', checked: currentTypes.includes('file') },
                ],
            },
        ]);

        return selectedTypes;
    }

    async confirmAction(message: string): Promise<boolean> {
        const { confirmed } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirmed',
                message: message,
                default: false,
            },
        ]);

        return confirmed;
    }

    async showOtherSettingsMenu(): Promise<string> {
        console.clear();
        this.logger.info('===== 其他设置 =====\n');
        
        const { choice } = await inquirer.prompt([
            {
                type: 'list',
                name: 'choice',
                message: '请选择要配置的选项:',
                choices: [
                    { name: '[1] 并发下载数设置', value: '1' },
                    { name: '[2] 文件分类存储设置', value: '2' },
                    { name: '[3] 消息聚合设置', value: '3' },
                    { name: '[0] 返回主菜单', value: '0' },
                ],
            },
        ]);
        
        return choice;
    }

    async inputNumber(message: string, defaultValue: number): Promise<number> {
        const { value } = await inquirer.prompt([
            {
                type: 'input',
                name: 'value',
                message: message,
                default: defaultValue.toString(),
                validate: (input) => {
                    const num = parseInt(input, 10);
                    if (isNaN(num) || num <= 0) {
                        return '请输入有效的正整数';
                    }
                    return true;
                },
            },
        ]);
        
        return parseInt(value, 10);
    }

    async toggleSetting(message: string, currentValue: boolean): Promise<boolean> {
        const { value } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'value',
                message: message,
                default: currentValue,
            },
        ]);
        
        return value;
    }

    showSuccess(message: string) {
        this.logger.info(`✓ ${message}`);
    }

    showError(message: string) {
        this.logger.error(`✗ ${message}`);
    }

    async waitForKeyPress(message: string = '\n按 Enter 继续...') {
        await inquirer.prompt([
            {
                type: 'input',
                name: 'continue',
                message: message,
            },
        ]);
    }
}
